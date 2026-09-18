"""Out-of-process engines.  Each worker runs in its own virtual environment
(the TTS packages pin incompatible dependencies) and speaks the framed
protocol in `protocol.py` over stdin/stdout.  Worker modules must import
nothing from the server package except `protocol`."""
