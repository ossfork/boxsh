# Test image for boxsh under Docker.
#
# Used by tests/docker-test.sh (dev + CI).  The boxsh binary is built ONCE on
# the host/runner and mounted into the container — a single binary serves both
# the host and container test runs.  This image therefore only needs to provide
# what the *runtime* requires beyond the base image:
#   - fuse-overlayfs   COW engine inside overlay2 containers (kernel
#                       overlay-on-overlay is unsupported); pulls libfuse3.
#
# The base node:22-bookworm image already supplies Node 22 (the `node --test`
# runner) and libtinfo/libstdc++/libc, which satisfy the boxsh binary's dynamic
# dependencies (see `ldd build/boxsh`).
#
# The container still needs these run-time grants (see docker-test.sh):
#   --cap-add SYS_ADMIN --security-opt seccomp=unconfined \
#   --security-opt apparmor=unconfined --device /dev/fuse

FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
        fuse-overlayfs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
