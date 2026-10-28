FROM ghcr.io/rebuno/rebuno:latest AS kernel

FROM node:25-trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gh git postgresql ripgrep libnss-wrapper && \
    rm -rf /var/lib/apt/lists/* && \
    ln -s /usr/lib/postgresql/*/bin /usr/local/lib/postgresql && \
    ln -s /usr/lib/*/libnss_wrapper.so /usr/local/lib/libnss_wrapper.so

RUN git config --system credential.https://github.com.helper \
    '!f() { token="${GITHUB_TOKEN:-$GH_TOKEN}"; test "$1" = get && test -n "$token" && printf "username=x-access-token\npassword=%s\n" "$token"; }; f'

ENV PATH=/usr/local/lib/postgresql:$PATH PNPM_HOME=/pnpm

COPY --from=kernel /usr/local/bin/rebuno /usr/local/bin/rebuno

RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node_modules/.bin/playwright install --with-deps --only-shell chromium && \
    rm -rf /var/lib/apt/lists/*

COPY src src

RUN useradd --create-home nu && chmod 755 /home/nu && \
    mkdir /home/nu/.nu && chown nu /home/nu/.nu && \
    printf '#!/bin/sh\ncd /app && exec node --import tsx src/cli.ts "$@"\n' > /usr/local/bin/nu && \
    chmod +x /usr/local/bin/nu
COPY scripts/docker-entrypoint.sh /usr/local/bin/nu-entrypoint
RUN chmod +x /usr/local/bin/nu-entrypoint

USER nu
ENV NU_LISTEN_HOST=0.0.0.0 NU_HOME=/home/nu/.nu HOME=/home/nu/.nu/home
EXPOSE 4122
ENTRYPOINT ["nu-entrypoint"]
CMD ["node", "--disable-sigusr1", "--import", "tsx", "src/start.ts"]
