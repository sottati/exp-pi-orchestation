import os
import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from crawler import crawl_url
from interactor import interact_page as interact_task

logging.basicConfig(
    level=getattr(logging, os.environ.get("BROWSE_SERVICE_LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("browse-service.api")

app = FastAPI(title="pi-browse-service")


class BrowseRequest(BaseModel):
    url: str
    wait_for: str | None = None


class InteractRequest(BaseModel):
    url: str
    task: str
    api_key: str | None = None


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/browse")
async def browse(req: BrowseRequest):
    try:
        result = await crawl_url(req.url, req.wait_for)
        return result
    except Exception as e:
        logger.exception("browse failed url=%s wait_for=%s", req.url, req.wait_for)
        return JSONResponse(status_code=500, content={"error": f"{type(e).__name__}: {e}"})


@app.post("/interact")
async def interact(req: InteractRequest):
    try:
        result = await interact_task(req.url, req.task, req.api_key)
        return result
    except Exception as e:
        logger.exception("interact failed url=%s task_len=%s", req.url, len(req.task))
        return JSONResponse(status_code=500, content={"error": f"{type(e).__name__}: {e}"})
