FROM python:3.12-slim

# Set working directory
WORKDIR /app

# Set HF_HOME environment variable for Hugging Face cache
# Use /tmp instead of /app to avoid read-only filesystem issues
ENV HF_HOME=/tmp/.cache/huggingface
ENV TRANSFORMERS_CACHE=${HF_HOME}
ENV HF_DATASETS_CACHE=${HF_HOME}

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create cache directory with proper permissions
RUN mkdir -p ${HF_HOME} && chmod 777 ${HF_HOME}

# Expose port
EXPOSE 8000

# Run the application with eager loading
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
