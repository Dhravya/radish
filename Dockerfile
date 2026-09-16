FROM python:3.11-slim

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src/ src/

RUN pip install --no-cache-dir -e .

EXPOSE 8080

CMD ["agent-optimize", "serve"]
