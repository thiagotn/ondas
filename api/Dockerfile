# Imagem da API do acervo. Contexto de build = este diretório (`api/`), para
# não arrastar o monorepo inteiro para dentro do contexto.
FROM golang:1.26-alpine AS builder
WORKDIR /src

# Camada de dependências: só muda quando go.mod/go.sum mudam.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN go test ./... && \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

# scratch: o binário é estático e a API não executa nada do sistema. Só os
# certificados entram, para o TLS da fase 2 (R2) funcionar.
FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /out/api /api

# Sem shell e sem usuário no scratch: roda com um uid alto e fixo, que o
# deployment confirma com runAsNonRoot.
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/api"]
