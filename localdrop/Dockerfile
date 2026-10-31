FROM python:3.11-slim

WORKDIR /app

# Non-root user for security
RUN groupadd -r localdrop && useradd -r -g localdrop -m localdrop

COPY pyproject.toml .
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" python-multipart qrcode[pil] vobject httpx

COPY localdrop/app ./localdrop/app
RUN mkdir -p /app/data/uploads && chown -R localdrop:localdrop /app/data

USER localdrop

EXPOSE 8000

VOLUME ["/app/data"]

CMD ["python", "-m", "localdrop.app.main", "--lan", "--port", "8000"]
