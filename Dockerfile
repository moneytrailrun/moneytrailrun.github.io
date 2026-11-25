FROM node:22-bookworm-slim

ARG GODOT_VERSION=4.7.2
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && curl -fsSL --retry 3 \
       "https://github.com/godotengine/godot-builds/releases/download/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip" \
       -o /tmp/godot.zip \
    && unzip -p /tmp/godot.zip "Godot_v${GODOT_VERSION}-stable_linux.x86_64" > /usr/local/bin/godot \
    && chmod 755 /usr/local/bin/godot \
    && rm -rf /tmp/godot.zip /var/lib/apt/lists/*

WORKDIR /app
COPY MoneyTrail-0.9.5-Web-Loot-Update.zip /tmp/site.zip
RUN unzip -q /tmp/site.zip game/index.pck -d /app && rm /tmp/site.zip
COPY gateway.mjs gateway.mjs

USER node
EXPOSE 10000
CMD ["node", "gateway.mjs"]
