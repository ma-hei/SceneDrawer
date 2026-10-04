"""Object server: hands out the 3D objects that the Scene Drawer (scene-drawer/) draws.

Every object is one JSON file in objects/ (the file name is the object's name). Which of them
the scene shows, and where, is listed in scene.json: an object's name, or an instance that
places it with its own id and transform, so one object can appear several times; without
scene.json, every object is shown once. Change either while the server runs: the viewer polls and picks it up within a few
seconds.

    GET /api/scene/objects        the list of objects: [{"id", "version"}], cheap, polled
    GET /api/scene/objects/{id}   one object in full: mesh, transform, motion

The version is a hash of the file's contents, so it changes exactly when the object does; the
viewer fetches an object only if it hasn't got that version yet.

Run:  .venv/bin/uvicorn server:app --port 8091

Environment:
    ALLOWED_ORIGINS     comma-separated origins whose pages may call this server
                        (default http://localhost:5173)
    SCENE_OBJECTS_DIR   where the object files are (default: objects/ next to this file)
    SCENE_FILE          the list of objects to show (default: scene.json next to this file)
"""

import hashlib
import json
import logging
import os
import re
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ValidationError, model_validator

log = logging.getLogger("uvicorn.error")

OBJECTS_DIR = Path(os.environ.get("SCENE_OBJECTS_DIR") or Path(__file__).parent / "objects")
SCENE_FILE = Path(os.environ.get("SCENE_FILE") or Path(__file__).parent / "scene.json")
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173").split(",") if o.strip()]
ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")  # also keeps ids from reaching outside objects/

Vec3 = tuple[float, float, float]


# ---------------- the object format ----------------
Primitive = Literal["triangles", "lines"]
VERTICES_PER = {"triangles": 3, "lines": 2}  # how many indices make one primitive


class Mesh(BaseModel):
    """positions: x, y, z per vertex; colors: r, g, b (0..1) per vertex; indices: which
    vertices are connected, three per triangle or two per line (see primitive)."""

    primitive: Primitive = "triangles"  # "lines": a surface-less object, e.g. an outline or a wireframe
    positions: list[float]
    colors: list[float] | None = None  # missing: every vertex light grey
    indices: list[int] | None = None   # missing: vertices in order (0,1,2 a triangle / 0,1 a line, ...)

    @model_validator(mode="after")
    def check(self) -> "Mesh":
        if not self.positions or len(self.positions) % 3:
            raise ValueError("positions needs x, y, z for every vertex")
        count = len(self.positions) // 3
        if self.colors is None:
            self.colors = [0.8] * (3 * count)
        elif len(self.colors) != 3 * count:
            raise ValueError(f"colors needs r, g, b for each of the {count} vertices")
        per = VERTICES_PER[self.primitive]
        shape = "triangle" if per == 3 else "line"
        if self.indices is None:
            if count % per:
                raise ValueError(f"without indices, the vertex count must be a multiple of {per}")
            self.indices = list(range(count))
        elif not self.indices or len(self.indices) % per or any(i < 0 or i >= count for i in self.indices):
            raise ValueError(f"indices needs {per} vertex numbers (0..{count - 1}) per {shape}")
        return self


class Transform(BaseModel):
    """Where the object stands: scaled, then rotated, then moved."""

    translation: Vec3 = (0, 0, 0)
    rotation: Vec3 = (0, 0, 0)  # degrees around x, y, z
    scale: Vec3 = (1, 1, 1)


class StaticMotion(BaseModel):
    """The object stands still. Animations become further motion types (e.g. "spin" with an
    axis and a speed, or "path" with waypoints), as a union discriminated by "type"; the
    viewer treats types it doesn't know as static."""

    type: Literal["static"] = "static"


class ObjectFile(BaseModel):
    """What an object file in objects/ contains."""

    description: str = ""
    mesh: Mesh
    transform: Transform = Transform()
    motion: StaticMotion = StaticMotion()


class SceneObject(ObjectFile):
    """What the viewer receives: the file's contents plus id and version."""

    id: str
    version: str


class ObjectSummary(BaseModel):
    id: str
    version: str


class ObjectList(BaseModel):
    objects: list[ObjectSummary]


# ---------------- loading, with a cache per file ----------------
# path -> ((modification time, size), the object or None if the file is invalid)
_cache: dict[Path, tuple[tuple[int, int], SceneObject | None]] = {}


def _load(object_id: str) -> SceneObject | None:
    path = OBJECTS_DIR / f"{object_id}.json"
    try:
        stat = path.stat()
        key = (stat.st_mtime_ns, stat.st_size)
        cached = _cache.get(path)
        if cached and cached[0] == key:
            return cached[1]
        data = path.read_bytes()
    except OSError:  # missing, or deleted just now
        _cache.pop(path, None)
        return None
    try:
        parsed = ObjectFile.model_validate_json(data)
        obj = SceneObject(**parsed.model_dump(), id=object_id, version=hashlib.sha256(data).hexdigest()[:16])
    except ValidationError as e:
        log.warning("skipping %s: %s", path.name, e)
        obj = None
    _cache[path] = (key, obj)
    return obj


# ---------------- the scene: which objects, where ----------------
class TransformOverride(BaseModel):
    """Replaces parts of the object file's transform; what's left out stays as in the file."""

    translation: Vec3 | None = None
    rotation: Vec3 | None = None
    scale: Vec3 | None = None


class Instance(BaseModel):
    """One entry in scene.json: an object from objects/, optionally placed differently.
    The same object can appear several times, each with its own id."""

    id: str | None = None  # the id the viewer sees; default: the object's name
    object: str            # file name in objects/, without .json
    transform: TransformOverride = TransformOverride()


class SceneFile(BaseModel):
    """scene.json. Each entry is an object's name ("rectangle") or an instance
    ({"id": "rectangle-top", "object": "rectangle", "transform": {"translation": [0, 2, 0]}})."""

    objects: list[str | Instance]


_scene_cache: tuple[tuple[int, int], dict[str, Instance]] | None = None


def _instances() -> dict[str, Instance]:
    """What the scene contains: id -> instance, in the order of scene.json. Without scene.json,
    every object file once, as it is. Re-read when the file changes, so editing it changes the
    scene while the server runs."""
    global _scene_cache
    try:
        stat = SCENE_FILE.stat()
    except OSError:
        return {p.stem: Instance(object=p.stem) for p in sorted(OBJECTS_DIR.glob("*.json")) if ID.match(p.stem)}
    key = (stat.st_mtime_ns, stat.st_size)
    if _scene_cache and _scene_cache[0] == key:
        return _scene_cache[1]
    instances: dict[str, Instance] = {}
    try:
        for entry in SceneFile.model_validate_json(SCENE_FILE.read_bytes()).objects:
            instance = Instance(object=entry) if isinstance(entry, str) else entry
            instance_id = instance.id or instance.object
            if not ID.match(instance_id) or not ID.match(instance.object):
                log.warning("%s: skipping %r: ids may only use letters, digits, - and _", SCENE_FILE.name, instance_id)
            elif instance_id in instances:
                log.warning("%s: skipping the second %r: ids must be unique", SCENE_FILE.name, instance_id)
            else:
                if not (OBJECTS_DIR / f"{instance.object}.json").is_file():
                    log.warning("%s: %r uses %r, which doesn't exist", SCENE_FILE.name, instance_id, instance.object)
                instances[instance_id] = instance
    except (OSError, ValidationError) as e:
        log.warning("%s is invalid, showing no objects: %s", SCENE_FILE.name, e)
        instances = {}  # a broken scene file shows nothing rather than everything
    _scene_cache = (key, instances)
    return instances


def _place(instance_id: str, instance: Instance) -> SceneObject | None:
    """The object as this instance shows it: its own id, and its transform overrides applied."""
    obj = _load(instance.object)
    if obj is None:
        return None
    overrides = instance.transform.model_dump(exclude_none=True)
    if instance_id == obj.id and not overrides:
        return obj
    # The version must change when the object file or the instance's placement changes.
    placement = json.dumps(overrides, sort_keys=True)
    version = hashlib.sha256(f"{obj.version}:{placement}".encode()).hexdigest()[:16]
    transform = obj.transform.model_copy(update=overrides)
    return obj.model_copy(update={"id": instance_id, "version": version, "transform": transform})


def _all() -> list[SceneObject]:
    placed = (_place(instance_id, instance) for instance_id, instance in _instances().items())
    return [obj for obj in placed if obj]


# ---------------- the API ----------------
app = FastAPI(title="Object server")
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["GET"])


@app.get("/api/scene/objects")
def list_objects() -> ObjectList:
    return ObjectList(objects=[ObjectSummary(id=o.id, version=o.version) for o in _all()])


@app.get("/api/scene/objects/{object_id}")
def get_object(object_id: str) -> SceneObject:
    instance = _instances().get(object_id)
    obj = _place(object_id, instance) if instance else None
    if obj is None:
        raise HTTPException(404, f"no object {object_id!r}")
    return obj
