from __future__ import annotations

import argparse
import os

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="Quokka backend desktop sidecar")
    parser.add_argument("--host", default=os.environ.get("QUOKKA_BACKEND_HOST", "127.0.0.1"))
    parser.add_argument("--port", default=int(os.environ.get("QUOKKA_BACKEND_PORT", "8000")), type=int)
    args = parser.parse_args()

    uvicorn.run("app.main:app", host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
