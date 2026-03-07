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
└── static/
    └── index.html       # Chat widget UI
```
