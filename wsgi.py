from app import app, socketio

# Gunicorn entrypoint
# Use: gunicorn -k eventlet -w 1 -b 0.0.0.0:10000 wsgi:app (HTTP)
# Or for SocketIO: gunicorn -k eventlet -w 1 -b 0.0.0.0:10000 wsgi:socketio_app

# Provide explicit socketio app reference if needed
socketio_app = app  # compatibility alias
