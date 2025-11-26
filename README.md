# MLflow Viewer

A web-based terminal interface for managing and viewing MLflow experiments with AWS S3 integration.

## Features

- **Interactive Terminal**: Browser-based terminal for running MLflow commands
- **AWS S3 Integration**: Browse and manage S3 buckets for MLflow artifacts
- **Real-time Updates**: WebSocket-based terminal output streaming
- **Clean UI**: Modern interface for MLflow experiment tracking

## Installation

```bash
pip install -r requirements.txt
```

## Usage

```bash
python run.py
```

Access the application at `http://localhost:5000`

## Requirements

- Python 3.7+
- AWS credentials configured (for S3 features)
- MLflow installed in your environment

## Tech Stack

- Flask + SocketIO for backend
- Vanilla JavaScript for frontend
- AWS Boto3 for S3 operations
