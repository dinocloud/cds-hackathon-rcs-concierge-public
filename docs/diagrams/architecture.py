"""Diagrama de arquitectura del concierge RCS (ADR 001) con iconos oficiales de AWS.

Uso (requiere graphviz: `brew install graphviz`):
    uv run --with diagrams python docs/diagrams/architecture.py [carpeta_salida]

Genera architecture.png y architecture.svg en la carpeta de salida (default: docs/diagrams).
"""
import os
import sys

from diagrams import Cluster, Diagram, Edge
from diagrams.aws.compute import Lambda
from diagrams.aws.database import DynamodbTable
from diagrams.aws.engagement import Pinpoint
from diagrams.aws.integration import SNS, EventbridgeScheduler, SQS
from diagrams.aws.management import Cloudwatch
from diagrams.aws.ml import Bedrock
from diagrams.generic.device import Mobile

OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
OUT_FILE = os.path.join(OUT_DIR, "architecture")

GRAPH = {"fontsize": "20", "pad": "0.4", "nodesep": "0.7", "ranksep": "0.9", "splines": "spline"}
FALLBACK = Edge(color="firebrick", style="dashed", label="fallback SMS (TTL)")


def render(fmt: str) -> None:
    with Diagram(
        "Aurora Concierge RCS: arquitectura (ADR 001)",
        filename=OUT_FILE,
        outformat=fmt,
        show=False,
        direction="LR",
        graph_attr=GRAPH,
    ):
        patient_rcs = Mobile("Paciente\n(RCS)")
        patient_sms = Mobile("Paciente\n(sin RCS: SMS)")

        with Cluster("Messaging stack"):
            eum = Pinpoint("End User Messaging\nRCS Agent + número SMS")
            topic = SNS("SNS topic\ninbound, postbacks,\nentregas")
            router = Lambda("inbound-router")
            dlq = SQS("DLQ del router")

        with Cluster("Agent stack"):
            runtime = Bedrock("AgentCore Runtime\n(agente Strands)")
            memory = Bedrock("AgentCore Memory")
            gateway = Bedrock("AgentCore Gateway\n(MCP)")

        with Cluster("Data stack"):
            tools = Lambda("tools")
            catalog = DynamodbTable("catalog")
            appointments = DynamodbTable("appointments")
            events = DynamodbTable("message-events")
            scheduler = EventbridgeScheduler("Scheduler\nT-48h / T-24h")
            reminder = Lambda("reminder-sender")

        with Cluster("Observability stack"):
            dashboard = Cloudwatch("Dashboard\nRCS vs SMS")

        patient_rcs >> Edge(label="mensajes y botones") >> eum
        eum >> Edge(label="eventos") >> topic >> router
        router >> Edge(label="InvokeAgentRuntime") >> runtime
        runtime - memory
        runtime >> gateway >> tools
        tools >> [catalog, appointments]
        tools >> Edge(label="al reservar") >> scheduler >> reminder
        router >> Edge(label="SendRcsMessage") >> eum
        reminder >> Edge(label="SendRcsMessage") >> eum
        eum >> Edge(label="RCS") >> patient_rcs
        eum >> FALLBACK >> patient_sms
        router >> Edge(label="estados de entrega") >> events
        router >> Edge(style="dotted", label="métricas EMF") >> dashboard
        router >> Edge(color="firebrick", style="dashed", label="eventos fallidos\n\n") >> dlq
        router >> Edge(label="upsertContact\n(CONTACT#)") >> appointments
        reminder >> Edge(label="turno y CONTACT#") >> appointments
        reminder >> Edge(label="provider") >> catalog


if __name__ == "__main__":
    for fmt in ("png", "svg"):
        render(fmt)
    print(f"OK: {OUT_FILE}.png y {OUT_FILE}.svg")
