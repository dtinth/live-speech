import { useStore } from "@nanostores/react";
import { atom } from "nanostores";
import { useState } from "react";
import { log } from "../logbus";
import { LogViewer } from "./LogViewer";

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

let audioContext: AudioContext | null = null;
function getAudioContext() {
  return (audioContext ??= new AudioContext({ sampleRate: 16000 }));
}

function createAudioSender(options: {
  websocketUrl: string;
  deviceId: string;
  abortSignal: AbortSignal;
  onLog: (message: string) => void;
}) {
  const { websocketUrl, deviceId, abortSignal, onLog } = options;
  const audioContext = getAudioContext();

  const workletCode = `
    class AudioSenderProcessor extends AudioWorkletProcessor {
      process(inputs) {
        const input = inputs[0];
        if (input.length > 0) {
          const inputData = input[0];
          const outputData = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            const s = Math.max(-1, Math.min(1, inputData[i]));
            outputData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          this.port.postMessage(outputData.buffer, [outputData.buffer]);
        }
        return true;
      }
    }
    registerProcessor('audio-sender-processor', AudioSenderProcessor);
  `;

  const connect = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
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

      const socket = new WebSocket(websocketUrl);

      socket.onopen = () => {
        onLog("WebSocket connected");
      };

      socket.onclose = (event) => {
        onLog(`WebSocket disconnected: ${event.reason}`);
        setTimeout(connect, 1000); // Attempt to reconnect after 1 second
      };

      socket.onerror = (error) => {
        onLog(`WebSocket error: ${error}`);
      };

      workletNode.port.onmessage = (event) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(event.data);
        }
      };

      abortSignal.addEventListener("abort", () => {
        onLog("Audio sender aborted");
        stream.getTracks().forEach((track) => track.stop());
        socket.close();
        URL.revokeObjectURL(workletUrl);
      });
    } catch (error) {
      onLog(`Error in audio sender: ${error}`);
      setTimeout(connect, 1000); // Attempt to reconnect after 1 second
    }
  };

  connect();
}

const $active = atom<{
  abortController: AbortController;
} | null>(null);

export function AudioSender() {
  const devices = useStore($devices);
  const active = useStore($active);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");

  const toggle = () => {
    const active = $active.get();
    if (active) {
      active.abortController.abort();
      $active.set(null);
    } else if (selectedDeviceId) {
      const abortController = new AbortController();
      $active.set({ abortController });
      createAudioSender({
        websocketUrl: "ws://localhost:10300/publish/1",
        deviceId: selectedDeviceId,
        abortSignal: abortController.signal,
        onLog(message) {
          log(message);
        },
      });
    }
  };

  return (
    <>
      <h1>Audio sender</h1>
      <div className="d-flex gap-2">
        <button
          className="btn btn-primary flex-shrink-0"
          onClick={getDeviceList}
          disabled={!!active}
        >
          {devices.length > 0 ? "Refresh" : "Get"} device list
        </button>
        <select
          className="form-select flex-grow-1 flex-shrink-1"
          disabled={!!active}
          value={selectedDeviceId}
          onChange={(event) => setSelectedDeviceId(event.target.value)}
        >
          <option value="">-- Select a microphone --</option>
          {devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || `Microphone ${device.deviceId}`}
            </option>
          ))}
        </select>
        <button className="btn btn-primary flex-shrink-0" onClick={toggle}>
          {active ? "Stop" : "Start"}
        </button>
      </div>
      <div className="mt-3">
        <LogViewer />
      </div>
    </>
  );
}
