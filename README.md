# live-speech

This project aims to provide live speech transcription for tech events, specifically designed to support Thai tech talks where there's a mixture of Thai words and technical terms. The system offers real-time transcription with post-processing capabilities for improved accuracy.

## Components

![A flowchart on a black background illustrates the workflow of an audio transcription system: Audio Sender, Server, Realtime Transcriber, Batch Transcriber, and Viewer.](https://im.dt.in.th/ipfs/bafybeibhbdvrey26ieetdcjzf443quorx5xe4vjrf5rt6dit4ay3paitqq/image.webp)

### Audio Sender

- Web-based, using `getUserMedia` API
- Responsible for capturing audio from the speaker's device, converting it to 16-bit linear PCM audio data, and sends it to the server using WebSockets

### Server

- Acts as the central backend for the application
- Handles database operations and pub/sub functionality
- Manages communication between different components

### Realtime Transcriber

- Performs streaming transcription in real-time
- Provides quick, albeit less accurate, transcriptions
- Useful for immediate feedback and live subtitles

### Batch Transcriber

- Uses a more advanced ASR model (Gemini 1.5 Flash) for improved accuracy
- Processes audio in batches for higher quality transcriptions

### Transcript Viewer

- Displays the transcribed text to the audience
- Shows both real-time and refined transcriptions

## Key Features

- Real-time audio capture and streaming
- Live transcription with quick feedback
- High-accuracy batch processing for refined transcripts
- Support for mixed Thai and English technical content

This system is designed to enhance the accessibility and documentation of Thai tech talks by providing accurate transcriptions that can handle the unique challenges of mixed-language technical presentations.

## Setup

```sh
# Install Node.js
mise install

# Enable corepack
corepack enable

# Install dependencies
pnpm install
```

`.env`:

```sh
# For local development
SERVER_URL_BASE=http://localhost:10300
FRONTEND_URL_BASE=http://localhost:4321

# Generate a random string for the secret key, e.g. using `openssl rand -hex 32`
SERVICE_TOKEN=

# For batch transcription
GEMINI_API_KEY=

# Change to "pro" for better transcription quality at higher cost
GEMINI_MODEL=flash

# For partial transcription with Speechmatics
PARTIAL_TRANSCRIBER_PROVIDER=speechmatics
SPEECHMATICS_API_KEY=

# For partial transcription with Google
# PARTIAL_TRANSCRIBER_PROVIDER=google
# GOOGLE_APPLICATION_CREDENTIALS=

# For partial transcription with local model (macOS only),
# compile this CLI <https://github.com/dtinth/transcribe> and set
# PARTIAL_TRANSCRIBER_PROVIDER=local
```

## How much does it cost?

The numbers are **approximate** and depends on which models you use.

Google Speech-To-Text model has lower latency (from Thailand) and cheaper, but performs worse than Speechmatics for Thai contents.

| Partial transcription model | Price per hour |
| --------------------------- | -------------- |
| `local`                     | $0.00          |
| `google`                    | $0.81          |
| `speechmatics`              | $1.18          |

Gemini Flash works great for Thai contents, but for English content Gemini Pro is recommended for better punctuation insertion.

| Batch transcription model | Price per hour |
| ------------------------- | -------------- |
| Gemini Flash              | $0.18          |
| Gemini Pro                | $2.97          |

## Workflow

1. Run the server:

   ```sh
   pnpm run server # or `pnpm run dev:server` to restart on file changes
   ```

2. Run the frontend:

   ```sh
   pnpm run dev
   ```

3. Create a room:

   ```sh
   pnpm run createRoom
   ```

4. Run partial transcriber:

   ```sh
   pnpm run partialTranscriber
   ```

5. Run batch transcriber:

   ```sh
   pnpm run batchTranscriber
   ```

6. Navigate to audio sender.
