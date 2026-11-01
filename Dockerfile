# Zom's HaRM server image. Starts as root only to fix ./data ownership, then runs as the 'harm' user.
#  docker compose up -d --build   (see docker-compose.yml and GUIDE.md)
FROM python:3.15-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HARM_DB=/data/harm.db HARM_PORT=8077 HARM_TLS=1
WORKDIR /app
# tesseract/zbar: reading labels · openssh-client: Import specs over SSH · iproute2/iputils/net-tools: Discover
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr zbar-tools openssh-client iproute2 iputils-ping net-tools \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -r -u 10001 -m -d /home/harm harm && mkdir /data && chown harm /data
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY harm ./harm
COPY docker/entrypoint.sh docker/healthcheck.py ./
RUN chmod 755 entrypoint.sh
VOLUME ["/data"]
EXPOSE 8077
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 CMD ["python", "/app/healthcheck.py"]
ENTRYPOINT ["/app/entrypoint.sh"]
