"""An in-memory stand-in for the boto3 S3 client calls Synari makes."""

import io
from collections.abc import Iterator
from pathlib import Path
from typing import Any, BinaryIO


class FakeS3:
    """Keeps objects per (bucket, key) and the upload options each one was written with."""

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.upload_args: dict[tuple[str, str], dict[str, str]] = {}

    def upload_fileobj(
        self, Fileobj: BinaryIO, Bucket: str, Key: str, ExtraArgs: dict[str, str] | None = None
    ) -> None:
        self.objects[Bucket, Key] = Fileobj.read()
        self.upload_args[Bucket, Key] = ExtraArgs or {}

    def upload_file(
        self, Filename: str, Bucket: str, Key: str, ExtraArgs: dict[str, str] | None = None
    ) -> None:
        with open(Filename, "rb") as source:
            self.upload_fileobj(source, Bucket, Key, ExtraArgs)

    def get_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        return {"Body": io.BytesIO(self.objects[Bucket, Key])}

    def download_file(self, Bucket: str, Key: str, Filename: str) -> None:
        Path(Filename).write_bytes(self.objects[Bucket, Key])

    def delete_object(self, Bucket: str, Key: str) -> None:
        self.objects.pop((Bucket, Key), None)

    def delete_objects(self, Bucket: str, Delete: dict[str, list[dict[str, str]]]) -> None:
        for item in Delete["Objects"]:
            self.delete_object(Bucket, item["Key"])

    def get_paginator(self, operation: str) -> "FakeS3":
        assert operation == "list_objects_v2"
        return self

    def paginate(self, Bucket: str, Prefix: str) -> Iterator[dict[str, Any]]:
        keys = sorted(key for bucket, key in self.objects if bucket == Bucket)
        yield {"Contents": [{"Key": key} for key in keys if key.startswith(Prefix)]}
