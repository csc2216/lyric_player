from fastapi import APIRouter

router = APIRouter(prefix="/api")


@router.get("/library")
def get_library() -> list:
    # M0 placeholder; real tree comes from services.library in M2.
    return []
