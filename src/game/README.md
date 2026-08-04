# Editor operations

The Server does not own an editor or gameplay operation contract. Its
`editor_transport` host tool forwards a versioned request to the interactive
Studio page selected by the request's explicit game scope. Discoverable methods,
validation, lifecycle, input, query, and capture all remain owned by the Editor
Gateway.

Managed renderer pages register with a distinct role. The carrier always prefers
a user-visible interactive Studio page and uses managed only as a UI-free
fallback. Runtime-carrier ensure/status/reveal/stop manage that renderer process
only; they are not aliases for Gateway play/stop.
