FROM oven/bun:1-debian

WORKDIR /app
COPY broker.ts ./

EXPOSE 4000

CMD ["bun", "run", "broker.ts"]
