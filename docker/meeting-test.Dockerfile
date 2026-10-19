# Linux image for the meeting audio tests (PulseAudio + ffmpeg + Xvfb on top of Playwright's browsers).
#   docker build -f docker/meeting-test.Dockerfile -t bosun-meeting-test .
#   docker run --rm -v "$PWD":/app -w /app bosun-meeting-test node --test test/meeting-audio.test.mjs
FROM mcr.microsoft.com/playwright:v1.64.1-noble
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      pulseaudio pulseaudio-utils ffmpeg xvfb xauth && rm -rf /var/lib/apt/lists/*
