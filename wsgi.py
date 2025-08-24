from app import app
try:
	from app import socketio
except Exception:
	socketio = None

# Gunicorn entrypoint
# Use: gunicorn -k eventlet -w 1 -b 0.0.0.0:10000 wsgi:app (HTTP)
# Or for SocketIO: gunicorn -k eventlet -w 1 -b 0.0.0.0:10000 wsgi:socketio_app

# Provide explicit socketio app reference if needed
# If SocketIO was initialized, expose it as socketio_app for Gunicorn (use wsgi:socketio_app)
socketio_app = socketio if socketio is not None else app
