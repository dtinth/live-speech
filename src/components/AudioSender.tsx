import { useStore } from "@nanostores/react";
import { encode } from "@stablelib/base64";
import { atom, computed } from "nanostores";
import ReconnectingWebSocket from "reconnecting-websocket";
import {
  $activationThreshold,
  $deactivationThreshold,
  $decayEasing,
  $maxLength as $maxAudioLength,
  $minimumPeak as $minimumLevel,
} from "../knobs";
import { log } from "../logbus";
import { LogViewer } from "./LogViewer";

let audioContext: AudioContext | null = null;
function getAudioContext() {
  return (audioContext ??= new AudioContext({ sampleRate: 16000 }));
}

interface BackendContext {
  backend: string;
  room: string;
  key: string;
}

export function AudioSender() {
  const params = new URLSearchParams(window.location.search);

  const backend = params.get("backend");
  const room = params.get("room");
  const key = params.get("key");
  if (!backend || !room || !key) {
    return <div>Missing parameters</div>;
  }

  const deviceId = params.get("deviceId");
  if (!deviceId) {
    return <AudioDeviceSelector />;
  }

  const backendContext: BackendContext = { backend, room, key };
  return (
    <AudioSenderView deviceId={deviceId} backendContext={backendContext} />
  );
}

const $devices = atom<MediaDeviceInfo[]>([]);

const getDeviceList = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());

    const deviceList = await navigator.mediaDevices.enumerateDevices();
    const audioInputDevices = deviceList.filter(
      (device) => device.kind === "audioinput"
    );

    $devices.set(audioInputDevices);
  } catch (error) {
    console.error("Error getting device list:", error);
  }
};

function AudioDeviceSelector() {
  const devices = useStore($devices);
  return (
    <>
      <h1>Select device</h1>
      <div>
        <button
          className="btn btn-primary flex-shrink-0"
          onClick={getDeviceList}
        >
          {devices.length > 0 ? "Refresh" : "Get"} device list
        </button>
      </div>
      <ul>
        {devices.map((device) => (
          <li key={device.deviceId}>
            <a href={`${location.search}&deviceId=${device.deviceId}`}>
              {device.label}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

function createAudioSenderController(options: {
  backendContext: BackendContext;
  deviceId: string;
  log: (message: string) => void;
}) {
  const { log, backendContext } = options;
  const $level = atom(0);
  const $realMax = atom(0);
  const $effectiveMax = computed(
    [$realMax, $minimumLevel],
    (realMax, minimumLevel) => Math.max(realMax, minimumLevel / 100)
  );
  const $current = atom(0);
  const $active = atom<string | null>(null);
  const $socketStatus = atom<"disconnected" | "authenticating" | "connected">(
    "disconnected"
  );
  const unackedMessages = new Map<string, any>();
  const $pendingEventCount = atom(0);
  const $started = atom(false);

  let currentBlockCount = 0;
  type SocketEvent =
    | { method: "start" }
    | { method: "audio"; params: { data: string } }
    | { method: "stop" };
  let onEvent: (event: SocketEvent) => void = () => {};

  async function start() {
    if ($started.get()) return;
    $started.set(true);
    await Promise.all([startAudio(), startWebsocket()]);
  }

  async function startAudio() {
    const audioContext = getAudioContext();

    const workletCode = `
      class AudioSenderProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.buffer = new Float32Array(1024);
          this.bufferIndex = 0;
        }

        process(inputs) {
          const input = inputs[0];
          if (input.length > 0) {
            const inputData = input[0];
            for (let i = 0; i < inputData.length; i++) {
              this.buffer[this.bufferIndex++] = inputData[i];

              if (this.bufferIndex === this.buffer.length) {
                const outputData = new Int16Array(this.buffer.length);
                for (let j = 0; j < this.buffer.length; j++) {
                  const s = Math.max(-1, Math.min(1, this.buffer[j]));
                  outputData[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                this.port.postMessage(outputData.buffer, [outputData.buffer]);
                this.bufferIndex = 0;
              }
            }
          }
          return true;
        }
      }
      registerProcessor('audio-sender-processor', AudioSenderProcessor);
    `;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: options.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: 16000,
        },
      });

      // Add the AudioWorklet module
      const blob = new Blob([workletCode], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      await audioContext.audioWorklet.addModule(workletUrl);

      const source = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(
        audioContext,
        "audio-sender-processor"
      );
      source.connect(workletNode);

      workletNode.port.onmessage = (event) => {
        const data = new Int16Array(event.data);
        // Calculate RMS
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          sum += (data[i] / 32768) ** 2;
        }
        const level = Math.sqrt(sum / data.length) * Math.sqrt(2);
        $level.set(level);
        if (level > $realMax.get()) {
          $realMax.set(level);
        } else {
          $realMax.set($realMax.get() * 0.995);
        }
        if (level > $current.get()) {
          $current.set(level);
        } else if ($active.get()) {
          const maxSamples = $maxAudioLength.get() * 16000;
          const maxBlocks = maxSamples / 1024;
          const progress =
            Math.min(1, currentBlockCount / maxBlocks) ** $decayEasing.get();
          const decayRate = 0.99 - progress * 0.5;
          $current.set($current.get() * decayRate);
        } else {
          $current.set(level);
        }
        if (!$active.get()) {
          const threshold = $effectiveMax.get() * $activationThreshold.get();
          if ($current.get() > threshold) {
            const id = `au${Date.now()}`;
            $active.set(id);
            currentBlockCount = 0;
            onEvent({ method: "start" });
            log(`Utterance started`);
          }
        } else if ($active.get()) {
          const threshold = $effectiveMax.get() * $deactivationThreshold.get();
          if ($current.get() < threshold) {
            $active.set(null);
            onEvent({ method: "stop" });
            const samples = currentBlockCount * 1024;
            const duration = samples / 16000;
            log(`Utterance finished, duration: ${duration.toFixed(2)}s`);
          } else {
            currentBlockCount++;
          }
        }
        if ($active.get()) {
          // Convert data into base64-encoded string.
          const base64 = encode(new Uint8Array(event.data));
          onEvent({ method: "audio", params: { data: base64 } });
        }
      };
    } catch (error) {
      options.log(`Error in audio sender: ${error}`);
    }
  }

  async function startWebsocket() {
    const { backend, room, key } = backendContext;
    const socket = new ReconnectingWebSocket(
      `${backend}/rooms/${room}/audioIngest?key=${key}`
    );
    socket.onopen = () => {
      log("WebSocket connected");
      $socketStatus.set("authenticating");
    };
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.method === "welcome") {
        log("Received welcome message");
        $socketStatus.set("connected");
        for (const message of unackedMessages.values()) {
          socket.send(message);
        }
      }
      if (data.id && unackedMessages.has(data.id)) {
        unackedMessages.delete(data.id);
        $pendingEventCount.set(unackedMessages.size);
      }
    };
    onEvent = (event) => {
      const id = crypto.randomUUID();
      const payload = JSON.stringify({ id, ...event });
      socket.send(payload);
      unackedMessages.set(id, payload);
      $pendingEventCount.set(unackedMessages.size);
    };
    socket.onclose = (event) => {
      log(`WebSocket disconnected: ${event.reason}`);
      $socketStatus.set("disconnected");
    };
  }

  return {
    $level,
    $max: $effectiveMax,
    $current,
    $active,
    start,
    $pendingEventCount,
    $started,
    $socketStatus,
  };
}

const levelToDb = (level: number) => 20 * Math.log10(level);
const levelToX = (level: number) => {
  const db = levelToDb(level);
  const x = Math.max(0, Math.min(1, (db + 100) / 100));
  return x;
};

type AudioSenderController = ReturnType<typeof createAudioSenderController>;
let _sender: AudioSenderController | undefined;

function AudioSenderView(props: {
  deviceId: string;
  backendContext: BackendContext;
}) {
  const sender = (_sender ??= createAudioSenderController({
    backendContext: props.backendContext,
    deviceId: props.deviceId,
    log: log,
  }));
  return (
    <>
      <StartButton sender={sender} />
      <LevelMeter sender={sender} />
      <StatusInspector sender={sender} />
      <Knobs />
      <LogViewer />
    </>
  );
}

function StartButton(props: { sender: AudioSenderController }) {
  const sender = props.sender;
  const started = useStore(sender.$started);
  return (
    <p>
      <button
        className="btn btn-primary"
        onClick={sender.start}
        disabled={started}
      >
        Start
      </button>
    </p>
  );
}

function StatusInspector(props: { sender: AudioSenderController }) {
  const status = useStore(props.sender.$socketStatus);
  const count = useStore(props.sender.$pendingEventCount);
  return (
    <p>
      Socket status: {status}
      <br />
      Pending events: {count}
    </p>
  );
}

function LevelMeter(props: { sender: AudioSenderController }) {
  const level = useStore(props.sender.$level);
  const max = useStore(props.sender.$max);
  const current = useStore(props.sender.$current);
  const active = useStore(props.sender.$active);
  const threshold =
    max * (active ? $deactivationThreshold.get() : $activationThreshold.get());
  return (
    <div
      className="border mb-3 position-relative"
      style={{ height: "16px", maxWidth: "720px" }}
    >
      <div
        className="position-absolute top-0 left-0 bottom-0 bg-primary"
        style={{
          width: `${levelToX(current) * 100}%`,
          opacity: "0.5",
        }}
      ></div>
      <div
        className="position-absolute top-0 left-0 bottom-0 bg-info"
        style={{
          width: `${levelToX(level) * 100}%`,
        }}
      ></div>
      <div
        className="position-absolute top-0 bottom-0 bg-danger"
        style={{
          left: `${levelToX(threshold) * 100}%`,
          width: "2px",
        }}
      ></div>
      <div
        className="position-absolute top-0 bottom-0 bg-success"
        style={{
          left: `${levelToX(max) * 100}%`,
          width: "2px",
        }}
      ></div>
    </div>
  );
}

function Knobs() {
  return (
    <div className="d-flex gap-3 mb-3 flex-wrap">
      <NumberKnob
        step="0.25"
        label="Max Audio Length"
        $value={$maxAudioLength}
      />
      <NumberKnob step="0.05" label="Decay Easing" $value={$decayEasing} />
      <NumberKnob
        step="0.1"
        label="Minimum Activation Level"
        $value={$minimumLevel}
      />
      <NumberKnob
        step="0.01"
        label="Activation Threshold"
        $value={$activationThreshold}
      />
      <NumberKnob
        step="0.01"
        label="Deactivation Threshold"
        $value={$deactivationThreshold}
      />
    </div>
  );
}

function NumberKnob({
  label,
  step,
  $value,
}: {
  label: string;
  step: string;
  $value: any;
}) {
  const value = useStore($value);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    $value.set(parseFloat(e.target.value));
  };

  return (
    <div>
      <label htmlFor={label} className="form-label text-muted">
        <small>{label}</small>
      </label>
      <input
        type="number"
        className="form-control"
        id={label}
        step={step}
        value={value}
        onChange={handleChange}
      />
    </div>
  );
}
