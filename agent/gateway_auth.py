"""Firma SigV4 para llamar al AgentCore Gateway (authorizer AWS_IAM) via MCP.

VERIFICAR contra la doc de Gateway con IAM inbound auth: servicio "bedrock-agentcore".
Las credenciales salen del rol del Runtime (cadena por defecto de boto3), nunca del repo.
"""
from __future__ import annotations

from typing import Generator

import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


class SigV4HttpxAuth(httpx.Auth):
    requires_request_body = True

    def __init__(self, service: str, region: str) -> None:
        self.service = service
        self.region = region
        self.session = boto3.Session()

    def auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        creds = self.session.get_credentials().get_frozen_credentials()
        aws_request = AWSRequest(
            method=request.method,
            url=str(request.url),
            data=request.content,
            headers={"host": request.url.host, "content-type": request.headers.get("content-type", "application/json")},
        )
        SigV4Auth(creds, self.service, self.region).add_auth(aws_request)
        request.headers.update(dict(aws_request.headers.items()))
        yield request
