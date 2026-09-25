# Image Wolflog : docker build -t wolflog . && docker run -p 5080:5080 -p 4317:4317 -p 4318:4318 -v wolflog-data:/data wolflog
FROM --platform=$BUILDPLATFORM node:24-alpine AS ui
WORKDIR /src/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npx ng build

# Compilation sur la machine de build, pour l'architecture cible (pas d'émulation).
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG TARGETARCH
ARG VERSION=0.1.0-local
WORKDIR /src
COPY global.json Directory.Build.props Directory.Packages.props README.md ./
COPY src/ src/
COPY --from=ui /src/src/Wolflog.Server/wwwroot src/Wolflog.Server/wwwroot
RUN dotnet publish src/Wolflog.Server -c Release -a $TARGETARCH -o /app -p:SkipUi=true -p:Version=${VERSION#v}

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app .
RUN mkdir -p /data && chown app:app /data
USER app
ENV Wolflog__DataDirectory=/data \
    ASPNETCORE_ENVIRONMENT=Production
VOLUME /data
EXPOSE 5080 4317 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["dotnet", "wolflog.dll", "healthcheck"]
ENTRYPOINT ["dotnet", "wolflog.dll"]
