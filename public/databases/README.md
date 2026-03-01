Offline music metadata files loaded by this app:

1. `acoustid.json`
2. `musicbrainz-recordings.json`
3. `coverart.json`

The app reads these files at runtime and resolves cover art locally, without search API calls.

Expected formats:

`acoustid.json`
```json
[
  {
    "fingerprint": "chromaprint-hash",
    "recordingId": "musicbrainz-recording-mbid",
    "score": 0.99
  }
]
```

`musicbrainz-recordings.json`
```json
[
  {
    "recordingId": "musicbrainz-recording-mbid",
    "releaseId": "musicbrainz-release-mbid",
    "title": "Song Title",
    "artist": "Artist Name",
    "album": "Album Name"
  }
]
```

`coverart.json`
```json
[
  {
    "releaseId": "musicbrainz-release-mbid",
    "artworkPath": "release-id.jpg"
  }
]
```

Cover art resolution priority:

1. `artworkDataUrl`
2. `artworkUrl`
3. `artworkPath` (resolved from `/databases/covers/<artworkPath>`)

You can keep cover files under `public/databases/covers/`.

