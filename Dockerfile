# Force x86_64 platform for Lambda compatibility
FROM --platform=linux/amd64 public.ecr.aws/lambda/nodejs:18

# Install system compilers/runtimes and dependencies
RUN yum update -y && yum install -y \
    gcc \
    gcc-c++ \
    clang \
    java-17-amazon-corretto \
    golang \
    php-cli \
    python3 \
    ruby \
    curl \
    wget \
    ca-certificates \
    unzip \
    zip \
    tar \
    xz \
    gzip \
    openssl \
    compat-openssl10 \
    && yum clean all

# Install Rust
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rust.sh \
 && sh /tmp/rust.sh -y \
 && rm /tmp/rust.sh
ENV PATH="/root/.cargo/bin:${PATH}"

# Install .NET SDK (C#)
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /usr/local/bin/dotnet-install.sh \
 && chmod +x /usr/local/bin/dotnet-install.sh \
 && /usr/local/bin/dotnet-install.sh --channel 8.0 --install-dir /usr/share/dotnet \
 && ln -s /usr/share/dotnet/dotnet /usr/bin/dotnet

# Set environment variables for Lambda-friendly builds
ENV TMPDIR=/tmp
ENV HOME=/tmp
ENV DOTNET_CLI_HOME=/tmp
ENV GOCACHE=/tmp/go-cache
ENV JAVA_HOME=/usr/lib/jvm/java-17-amazon-corretto
ENV PATH="$JAVA_HOME/bin:$PATH"

# Set working directory for Lambda
WORKDIR ${LAMBDA_TASK_ROOT}

# Copy Node.js dependencies and install
COPY package*.json ./
RUN npm install --production

# Copy source code
COPY . .

# Optional: ensure compilers are executable for the Lambda user
RUN chmod -R +x /usr/bin/go /usr/bin/gcc /usr/bin/g++ \
    /root/.cargo/bin/rustc /usr/bin/dotnet \
    /usr/lib/jvm/java-17-amazon-corretto/bin/

# Lambda handler (make sure your file exports 'handler')
CMD ["lambda.handler"]
