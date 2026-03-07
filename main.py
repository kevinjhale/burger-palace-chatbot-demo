import os
import pickle
import re
from pathlib import Path

import anthropic
from rank_bm25 import BM25Okapi
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

claude = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

INDEX_PATH = Path("bm25_index.pkl")

# In-memory BM25 index
bm25: BM25Okapi | None = None
chunks: list[str] = []


def tokenize(text: str) -> list[str]:
    """Lowercase, split on non-alphanumeric, remove empty tokens."""
    return [t for t in re.split(r"[^a-z0-9]+", text.lower()) if t]


def build_index():
    global bm25, chunks
    print("Building knowledge base index...")

    text = Path("knowledge_base.txt").read_text(encoding="utf-8")
    raw = [c.strip() for c in text.split("\n\n") if len(c.strip()) > 40]
    chunks = raw

    tokenized = [tokenize(c) for c in chunks]
    bm25 = BM25Okapi(tokenized)

    INDEX_PATH.write_bytes(pickle.dumps({"chunks": chunks, "bm25": bm25}))
    print(f"Index built: {len(chunks)} chunks.")


def load_index() -> bool:
    global bm25, chunks
    if INDEX_PATH.exists():
        data = pickle.loads(INDEX_PATH.read_bytes())
        chunks = data["chunks"]
        bm25 = data["bm25"]
        print(f"Index loaded: {len(chunks)} chunks.")
        return True
    return False


def retrieve_context(query: str, n: int = 5) -> str:
    if bm25 is None:
        return ""
    scores = bm25.get_scores(tokenize(query))
    top_indices = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:n]
    return "\n\n".join(chunks[i] for i in top_indices if scores[i] > 0)


SYSTEM_PROMPT = """You are Bella, the friendly AI assistant for Burger Palace.

Help customers with questions about the menu, hours, location, dietary needs,
ordering, and anything else related to Burger Palace.

RULES:
- Answer only using the context provided below. Do not make anything up.
- If the answer is not in the context, say: "I don't have that info on hand — give us a call at (555) 123-4567!"
- Never invent prices, items, or ingredients.
- Keep responses warm, friendly, and concise — 1 to 3 sentences max.
- Write in natural sentences. No bullet points, no markdown formatting.
- Never claim to be human. If asked, confirm you are Bella the AI assistant.

BURGER PALACE CONTEXT:
{context}"""


class ChatRequest(BaseModel):
    message: str
    history: list = []


class ChatResponse(BaseModel):
    response: str


@app.on_event("startup")
async def startup():
    if not load_index():
        build_index()


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    context = retrieve_context(req.message)

    # Build message history for Claude (alternating user/assistant required)
    history = req.history[-10:]

    response = claude.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=300,
        system=SYSTEM_PROMPT.format(context=context),
        messages=[
            *history,
            {"role": "user", "content": req.message}
        ]
    )

    return ChatResponse(response=response.content[0].text)


@app.post("/rebuild-index")
async def rebuild_index():
    build_index()
    return {"status": "ok", "message": "Index rebuilt."}


@app.get("/", response_class=HTMLResponse)
async def serve_widget():
    return HTMLResponse(content=Path("static/index.html").read_text(encoding="utf-8"))
