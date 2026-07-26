# Burger Palace Chatbot Demo

A RAG-powered restaurant chatbot demo. Answers menu questions, dietary info, hours, and more — using only the knowledge base, never hallucinating.

## Setup

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Add your OpenAI API key
cp .env.example .env
# Edit .env and paste your key

# 3. Run
uvicorn main:app --reload
```

Open http://localhost:8000 in your browser.

The knowledge base is indexed automatically on first run. To update the knowledge base, edit `knowledge_base.txt` and hit the `/rebuild-index` endpoint (or restart the server).

## Project Structure

```
chatbot-demo/
├── main.py              # FastAPI server, RAG pipeline, chat endpoint
├── knowledge_base.txt   # All restaurant content (edit this to update the bot)
├── requirements.txt
├── .env                 # Your OpenAI API key (not committed)
├── chroma_db/           # Auto-generated vector database (not committed)
├── static/
│   └── index.html       # Chat widget UI
└── switchbox/            # Standalone switch box wiring walkthrough app (see below)
```

## Switch Box Wiring Walkthrough

A separate, self-contained tool for walking someone through wiring a light switch box. It's plain HTML/CSS/JS (no API key, no build step) served alongside the chatbot at `/switchbox/`, or you can open `switchbox/index.html` directly in a browser.

Features:
- 1-gang, 2-gang, or 3-gang box setup, with each switch configurable as single-pole or 3-way.
- Wires are pulled in as real NM-B cable runs — 14/2 w/G, 12/2 w/G, or 14/3 w/G — each automatically split into its individual color-coded conductors (black/white/ground, or black/white/red/ground).
- Select two or more unassigned conductors and twist them into an editable wire nut — add, remove, rename, or delete the bundle at any time.
- Add a pigtail (a short jumper of a chosen color, gauge-matched to the splice) directly to a wire nut, then land its free end on any switch terminal — same as a real pigtail splice.
- Click any switch terminal to land a wire (including a pigtail) directly on it.
- A live step-by-step walkthrough (with Prev/Next and a jump list) that regenerates from the current wiring, plus a print view for handing someone a paper copy.
- State autosaves to the browser's local storage.
