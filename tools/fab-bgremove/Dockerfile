# VPS sweep service: auto-strips teal fabricator captures -> transparent WebP.
# Runs on the Coolify docker network next to the Timescale DB. See README.md "Automation".
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libgomp1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt "psycopg[binary]"

# Bake the u2net weights into the image so there's no runtime download.
RUN python -c "from rembg import new_session; new_session('u2net')"

COPY core.py sweep.py ./
CMD ["python", "sweep.py"]
