from fastapi import FastAPI

app = FastAPI(title="pi-browse-service")


@app.get("/health")
async def health():
    return {"status": "ok"}
