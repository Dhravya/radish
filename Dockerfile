FROM golang:1.18-alpine as builder

# Install git, required for fetching Go dependencies.
# Utilize the virtual package mechanism to keep the image small
RUN apk add --no-cache git

WORKDIR /app

COPY go.mod go.sum ./

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o main .

FROM scratch

COPY --from=builder /app/main /main

EXPOSE 6379

CMD ["/main"]
