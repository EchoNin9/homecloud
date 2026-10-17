FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

RUN useradd --system --uid 10001 --no-create-home bridge

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY homecloud_bridge ./homecloud_bridge

USER bridge
CMD ["python", "-m", "homecloud_bridge"]
