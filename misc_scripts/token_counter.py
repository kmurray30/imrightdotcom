#!/usr/bin/env python3
"""
Count tokens in a file using xAI's tokenize-text API.
Uses the model-specific tokenizer (default: grok-4-1-fast-non-reasoning).

Usage:
  python token_counter.py /path/to/file.txt
  python token_counter.py --model grok-3 /path/to/file.txt
Example:
    python misc_scripts/token_counter.py ref_extractor/extracted/all-world-leaders-are-in-cahoots-to-keep-us-under-control.yaml
"""

import argparse
import os
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

import requests

XAI_TOKENIZE_URL = "https://api.x.ai/v1/tokenize-text"
DEFAULT_MODEL = "grok-4-1-fast-non-reasoning"


def load_env() -> None:
    """Load XAI_API_KEY from env.local or .env in repo root if python-dotenv is available."""
    if load_dotenv is None:
        return
    script_dir = Path(__file__).resolve().parent
    repo_root = script_dir.parent
    for env_file in ("env.local", ".env"):
        env_path = repo_root / env_file
        if env_path.exists():
            load_dotenv(env_path)
            break


def count_tokens(file_path: str, model: str, api_key: str) -> int:
    """Read file and return token count from xAI tokenize-text API."""
    with open(file_path, "r", encoding="utf-8", errors="replace") as file_handle:
        text = file_handle.read()

    response = requests.post(
        XAI_TOKENIZE_URL,
        headers={"Authorization": f"Bearer {api_key}"},
        json={"text": text, "model": model},
        timeout=30,
    )
    response.raise_for_status()
    token_ids = response.json()["token_ids"]
    return len(token_ids)


def main() -> int:
    load_env()

    parser = argparse.ArgumentParser(
        description="Count tokens in a file using xAI's Grok tokenizer."
    )
    parser.add_argument(
        "file_path",
        type=str,
        help="Path to the file to count tokens for",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=DEFAULT_MODEL,
        help=f"Grok model for tokenization (default: {DEFAULT_MODEL})",
    )
    args = parser.parse_args()

    api_key = os.environ.get("XAI_API_KEY", "").strip()
    if not api_key:
        print("token_counter: XAI_API_KEY not set. Set it in env or env.local.", file=sys.stderr)
        return 1

    if not os.path.isfile(args.file_path):
        print(f"token_counter: file not found: {args.file_path}", file=sys.stderr)
        return 1

    try:
        token_count = count_tokens(args.file_path, args.model, api_key)
        print(token_count)
        return 0
    except requests.RequestException as request_error:
        print(f"token_counter: API error: {request_error}", file=sys.stderr)
        if hasattr(request_error, "response") and request_error.response is not None:
            try:
                body = request_error.response.json()
                if "error" in body:
                    print(f"  {body['error']}", file=sys.stderr)
            except Exception:
                pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
