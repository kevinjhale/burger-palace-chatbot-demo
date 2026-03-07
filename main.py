import os
import json
import pickle
import numpy as np
from openai import OpenAI
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from pathlib import Path

load_dotenv()

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

INDEX_PATH = Path("vector_index.pkl")

# In-memory store: list of {"text": str, "embedding": np.ndarray}
vector_store: list = []


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-10))


def embed(texts: list[str]) -> list[np.ndarray]:
    response = openai_client.embeddings.create(
        model="text-embedding-3-small",
        input=texts
    )
    return [np.array(r.embedding, dtype=np.float32) for r in response.data]


def build_index():
    global vector_store
    print("Building knowledge base index...")

    text = Path("knowledge_base.txt").read_text(encoding="utf-8")
    chunks = [c.strip() for c in text.split("\n\n") if len(c.strip()) > 40]

    print(f"Embedding {len(chunks)} chunks...")

    BATCH = 20
    store = []
    for i in range(0, len(chunks), BATCH):
        batch = chunks[i:i+BATCH]
        embeddings = embed(batch)
        for text_chunk, emb in zip(batch, embeddings):
            store.append({"text": text_chunk, "embedding": emb})

    vector_store = store
    INDEX_PATH.write_bytes(pickle.dumps(store))
    print(f"Index built: {len(store)} chunks stored.")


def load_index():
    global vector_store
    if INDEX_PATH.exists():
        vector_store = pickle.loads(INDEX_PATH.read_bytes())
        print(f"Index loaded: {len(vector_store)} chunks.")
        return True
    return False


def retrieve_context(query: str, n: int = 4) -> str:
    if not vector_store:
        return ""

    query_emb = embed([query])[0]

    scored = [
        (cosine_similarity(query_emb, item["embedding"]), item["text"])
        for item in vector_store
    ]
    scored.sort(reverse=True)
    top = [text for _, text in scored[:n]]
    return "\n\n".join(top)


SYSTEM_PROMPT = """You are Bella, the friendly assistant for Burger Palace.

Help customers with questions about the menu, hours, location, dietary needs,
ordering options, and anything else related to Burger Palace.

RULES:
- Only answer questions about Burger Palace using the context provided below.
- If the answer is not in the context, say: "I don't have that info on hand — give us a call at (555) 123-4567!"
- Never make up prices, items, or ingredients.
- Keep responses warm, friendly, and concise — 1 to 3 sentences max.
- Write in natural sentences, no bullet points or markdown.
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

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT.format(context=context)},
        *req.history[-10:],
        {"role": "user", "content": req.message}
    ]

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=messages,
        temperature=0.4,
        max_tokens=200
    )

    return ChatResponse(response=response.choices[0].message.content)


@app.post("/rebuild-index")
async def rebuild_index():
    build_index()
    return {"status": "ok", "message": "Index rebuilt."}


@app.get("/", response_class=HTMLResponse)
async def serve_widget():
    return HTMLResponse(content=Path("static/index.html").read_text(encoding="utf-8"))
