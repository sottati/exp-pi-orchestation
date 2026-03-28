from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from crawler import crawl_url
from interactor import interact_page as interact_task

app = FastAPI(title="pi-browse-service")


class BrowseRequest(BaseModel):
    url: str
    wait_for: str | None = None


class InteractRequest(BaseModel):
    url: str
    task: str


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/browse")
async def browse(req: BrowseRequest):
    try:
        result = await crawl_url(req.url, req.wait_for)
        return result
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/interact")
async def interact(req: InteractRequest):
    try:
        result = await interact_task(req.url, req.task)
        return result
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
