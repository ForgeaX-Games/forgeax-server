/** Studio product policy; independent of any standalone game connector. */
export const STUDIO_ASSET_LIBRARY_SKILL = `---
name: forgeax-studio-asset-library
description: Find official reusable assets for the current Studio game, import them through the Editor, and verify them in Play.
---

# Studio Asset Library

Use this skill when the game needs reusable vehicles, characters, props or scenery.
Plan a small asset list from the requested gameplay and art direction before searching.
Use the built-in search_game_assets with one to eight precise queries. Studio defaults
to EA; choose AW only when explicitly requested or authorized. An unavailable EA
service is a failure to report, not permission to silently switch libraries.

The official Provider downloads GLB sources and validates their manifests and hashes.
Its pinned binaries, verifier and execution worker are installed by Studio. Credentials
remain user-owned; never paste keys in chat or copy them into a game. A fresh machine
needs the configured official credential and Python 3.11/3.12. Missing tools or Provider
access must remain blocked. Do not install another game connector or change Engine.

Search results are candidates, not finished scene objects. Check each name and source
against the request; reject unrelated matches and explain missing assets. Keep selected
source paths and receipt identities. Import textures before models through the existing
Editor transport run.dispatch operation editor.importAsset, supplying sourceName,
destPath, requestId and source bytes (or an existing source path with skipUpload true).
For large binary files, use the existing file/terminal capability to copy only the
selected, verified source files into a new assets/library destination, keeping model
and texture relative paths together; reject existing destination conflicts. Then
call editor.importAsset on that game-relative path with skipUpload true. Do not
serialize a large binary payload through the model context. The copy stages sources;
only the Editor's terminal cook/import result establishes successful import.
Use the Editor's documented input schema and wait for the terminal import result.
Read the resulting project catalog and use its real GUIDs for scene/mesh/material
binding. Never copy GUIDs from another game, handwrite sidecars, or count accepted or
running operations as successful import. Preserve user-authored files on conflicts.

## Assemble the complete model

Apply these checks when using imported 3D models. They do not prescribe a game genre,
asset choice, camera style or gameplay feature; derive those from the user request.

Query the imported Scene GUID through editor_transport query, params.kind assets.payload,
using the discovered schema. Inspect payload.entities, each Transform and parent hierarchy.
A mesh payload contains local-space vertices; its bounds do not include the source node's
translation, rotation or scale. For a whole model, prefer the existing whole-Scene insertion
operation (addSceneAssetToScene when advertised) and persist through the normal authoring
path. When composing an authored Pack from mesh parts, preserve the source hierarchy,
node transforms and material bindings explicitly. Do not apply source transforms twice.

Measure the assembled model before choosing a gameplay scale. Transform local bounds
through the node hierarchy, then fit the result to the intended world dimensions. Existing
primitive meshes also have dimensions: entity scale multiplies those dimensions; it is
not a width/height/depth declaration. Check object proportions, placement and camera
framing against the intended scene; check collider fit and surface contact when the
game uses them. Do not patch visibility by guessing one
large scale multiplier or moving the camera without checking the actual model bounds.
If payload reading fails, use its diagnostic and recovery action; a catalog row alone
cannot establish geometry, transforms or successful scene placement.

If source scanning prevents the Editor from opening, game_asset_recovery exposes
inspect diagnostics and a rebuild action for one explicitly selected game-relative
sourcePath. Rebuild uses the official metadata producer and then the normal runtime
scan and bind. A missing source must be restored before rebuilding. metadataRebuilt
alone does not mean the runtime recovered; another diagnostic may still block it.
This is a producer recovery operation, not permission to handwrite generated metadata.

Bind the imported assets in the project's authored scene Pack and use normal Studio
Stop then Play. Verify visibility, orientation, scale and textures in the actual game.
For a reported invisible object, distinguish missing import/binding, wrong node transforms,
incorrect world dimensions, occlusion and camera framing using the current scene and a
real game frame. Check the requested object remains recognizable during normal interaction;
UI updates or changing runtime values do not prove the requested scene objects are visible.
An application DOM raster can omit embedded canvases. Its blank region is not evidence
that the game is black; use gameplay capture or a browser screenshot containing the actual
rendered game. An unavailable observation remains unverified, not a successful repair.
Report search, import/cook, binding and visible Play separately. Checkpoint the source
identity and actual runtime evidence. A downloaded GLB, catalog row or moving default
cube is not proof of the requested scene. Use the selected Editor page; follow an
available focus/reconnect recovery action once, and report an unresolved carrier
failure instead of repeatedly issuing Play or import operations.
`;
