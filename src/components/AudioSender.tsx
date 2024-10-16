import { useStore } from "@nanostores/react";
import { encode } from "@stablelib/base64";
import { atom } from "nanostores";
import ReconnectingWebSocket from "reconnecting-websocket";
import { log } from "../logbus";
import { LogViewer } from "./LogViewer";

let audioContext: AudioContext | null = null;
function getAudioContext() {
  return (audioContext ??= new AudioContext({ sampleRate: 16000 }));
}

export function AudioSender() {
  const params = new URLSearchParams(window.location.search);

  const deviceId = params.get("deviceId");
  if (!deviceId) {
    return <AudioDeviceSelector />;
  }

  return <AudioSenderView deviceId={deviceId} />;
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
            <a href={`?deviceId=${device.deviceId}`}>{device.label}</a>
          </li>
        ))}
      </ul>
    </>
  );
}

function createAudioSenderController(options: {
  deviceId: string;
  log: (message: string) => void;
}) {
  const { log } = options;
  const $level = atom(0);
  const $max = atom(0);
  const $current = atom(0);
  const $active = atom<string | null>(null);
  const $socketActive = atom(false);
  const unackedMessages = new Map<string, any>();
  const $pendingEventCount = atom(0);
  let currentLength = 0;
  let socketOpened = false;
  type SocketEvent =
    | { method: "start"; params: { id: string } }
    | { method: "audio"; params: { data: string } }
    | { method: "stop" };
  let onEvent: (event: SocketEvent) => void = () => {};

  async function start() {
    await Promise.all([startAudio(), startWebsocket()]);
  }

  async function startAudio() {
    const audioContext = getAudioContext();

    const workletCode = `
      class AudioSenderProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.buffer = new Float32Array(1280);
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
        if (level > $max.get()) {
          $max.set(level);
        } else {
          $max.set($max.get() * 0.995);
        }
        if (level > $current.get()) {
          $current.set(level);
        } else if ($active.get()) {
          const progress = Math.min(1, currentLength / 250);
          const decayRate = 0.99 - progress * 0.5;
          $current.set($current.get() * decayRate);
        } else {
          $current.set(level);
        }
        const threshold = $max.get() * 0.25;
        if (!$active.get()) {
          if ($current.get() > threshold) {
            const id = `au${Date.now()}`;
            $active.set(id);
            currentLength = 0;
            onEvent({ method: "start", params: { id } });
          }
        } else if ($active.get()) {
          if ($current.get() < threshold) {
            $active.set(null);
            onEvent({ method: "stop" });
          } else {
            currentLength++;
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
    const socket = new ReconnectingWebSocket(
      "ws://localhost:10300/rooms/hello/audioIngest?token=dummy"
    );
    socket.onopen = () => {
      log("WebSocket connected");
    };
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.method === "welcome") {
        log("Received welcome message");
        socketOpened = true;
        $socketActive.set(true);
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
    };
  }

  return {
    $level,
    $max,
    $current,
    start,
    $pendingEventCount,
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

function AudioSenderView(props: { deviceId: string }) {
  const sender = (_sender ??= createAudioSenderController({
    deviceId: props.deviceId,
    log: log,
  }));
  return (
    <>
      <p>
        <button className="btn btn-primary" onClick={sender.start}>
          Start
        </button>
      </p>
      <LevelMeter sender={sender} />
      <PendingEventCount sender={sender} />
      <LogViewer />
    </>
  );
}

function PendingEventCount(props: { sender: AudioSenderController }) {
  const count = useStore(props.sender.$pendingEventCount);
  return <div>Pending events: {count}</div>;
}

function LevelMeter(props: { sender: AudioSenderController }) {
  const level = useStore(props.sender.$level);
  const max = useStore(props.sender.$max);
  const threshold = max * 0.25;
  const current = useStore(props.sender.$current);
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
