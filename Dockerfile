FROM public.ecr.aws/lambda/nodejs:18

# System compilers/runtimes
RUN apt-get update && apt-get install -y \
    build-essential \
    clang \
    openjdk-17-jdk \
    golang-go \
    php \
    python3 \
    ruby-full \
    curl \
    wget \
    ca-certificates \
    apt-transport-https \
    kotlin \
    && rm -rf /var/lib/apt/lists/*

# Rust
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rust.sh \
 && sh /tmp/rust.sh -y \
 && rm /tmp/rust.sh
ENV PATH="/root/.cargo/bin:${PATH}"

# .NET SDK (C#)
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /usr/local/bin/dotnet-install.sh \
 && chmod +x /usr/local/bin/dotnet-install.sh \
 && /usr/local/bin/dotnet-install.sh --channel 8.0 --install-dir /usr/share/dotnet \
 && ln -s /usr/share/dotnet/dotnet /usr/bin/dotnet \
 && dotnet --info

# App setup
WORKDIR /app

# Copy package.json
COPY package*.json ./

# Install dependencies + devDependencies
RUN npm install --include=dev \
 && npm install --save-dev typescript @types/node ts-node

# Copy source code
COPY . .

# Add a default tsconfig.json (so Node types are recognized)
RUN npx tsc --init --rootDir ./ --outDir ./dist --esModuleInterop --resolveJsonModule --lib es2020,dom \
 && sed -i 's|"strict": true,|"strict": true,\n    "types": ["node"],|' tsconfig.json


CMD [ "lambda.handler" ]
