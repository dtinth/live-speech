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
