FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Baked into the static bundle. Use a same-origin path (/api) behind the bundled reverse proxy,
# or an absolute URL when the API is on its own domain.
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN npx vite build

FROM nginx:1.31.0-alpine-slim@sha256:241b0d0fe06250e026e7a35a008d022c9a1d3bec19442d65cc33b84d0b5dd64d
# Rendered into /etc/nginx/conf.d/default.conf at startup with CSP_CONNECT_SRC filled in.
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
# Extra connect-src origins for the Content-Security-Policy (LiveKit, a separate API domain).
ENV CSP_CONNECT_SRC=""
EXPOSE 3000
