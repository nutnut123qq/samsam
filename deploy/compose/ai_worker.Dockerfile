# syntax=docker/dockerfile:1
# AI worker Python (OCR paddle_local/Docling + STT faster-whisper) — HTTP nội bộ mạng ai_private.
# ai_worker/ (module + requirements.txt engine) do bước AI worker viết; model KHÔNG tải lúc build
# (mount AI_MODELS_DIR chỉ đọc — README).
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
COPY ai_worker/requirements.txt ai_worker/
RUN pip install --no-cache-dir -r requirements.txt && pip install --no-cache-dir -r ai_worker/requirements.txt
COPY ai_worker ai_worker
# STT dùng connectors.zalo_garden (stt_provider/audio_kind/_stt_whisper_local/MAX_MEDIA).
COPY connectors connectors
COPY ingest ingest
COPY pipelines pipelines
COPY data data
ENV PYTHONIOENCODING=utf-8 PYTHONUNBUFFERED=1
USER nobody
EXPOSE 8790
CMD ["python", "-m", "ai_worker"]
