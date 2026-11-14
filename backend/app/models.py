from pydantic import BaseModel, Field


class Point(BaseModel):
    x: int = Field(ge=0)
    y: int = Field(ge=0)


class PlanRequest(BaseModel):
    site_id: str = Field(default="gale", min_length=1, max_length=32)
    start: Point
    goal: Point
    constraints: dict = Field(default_factory=dict)


class ReplanRequest(BaseModel):
    plan_id: str
    obstacle: Point



class BenchmarkRequest(BaseModel):
    site_id: str = Field(default="gale", min_length=1, max_length=32)
    start: Point
    goal: Point
    constraints: dict = Field(default_factory=dict)


class ConditionUpdateRequest(BaseModel):
    plan_id: str
    cell: Point
    kind: str
    value: float
