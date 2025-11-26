import os
import pty
import select
import subprocess
import threading
import json
import boto3
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit

app = Flask(__name__)
app.config['SECRET_KEY'] = 'mlflow-viewer-secret'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Terminal management
class Terminal:
    def __init__(self, sid):
        self.sid = sid
        self.master, self.slave = pty.openpty()
        self.process = subprocess.Popen(
            ['/bin/bash', '-l'],
            stdin=self.slave,
            stdout=self.slave,
            stderr=self.slave,
            preexec_fn=os.setsid
        )
        self.running = True
        self.thread = threading.Thread(target=self._read_output)
        self.thread.daemon = True
        self.thread.start()

    def _read_output(self):
        while self.running:
            try:
                ready, _, _ = select.select([self.master], [], [], 0.1)
                if ready:
                    data = os.read(self.master, 1024)
                    if data:
                        socketio.emit('terminal_output', 
                                    {'data': data.decode('utf-8', errors='ignore')}, 
                                    room=self.sid)
            except:
                break

    def write(self, data):
        if self.running:
            os.write(self.master, data.encode('utf-8'))

    def resize(self, rows, cols):
        if self.running:
            import fcntl
            import termios
            import struct
            winsize = struct.pack('HHHH', rows, cols, 0, 0)
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, winsize)

    def close(self):
        self.running = False
        try:
            self.process.terminate()
            os.close(self.master)
            os.close(self.slave)
        except:
            pass

terminals = {}
user_credentials = {}

# S3 Configuration
RESULTS_BUCKET = 'genaietk-base-testdatas3bucketc0f5f0e6-5mkdrmoaaxg3'

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/sync-credentials', methods=['POST'])
def sync_credentials():
    """Sync credentials from terminal environment"""
    try:
        data = request.get_json()
        sid = data.get('socket_id')
        
        if sid in terminals:
            term = terminals[sid]
            filename = f"/tmp/aws_creds_{sid}.env"
            
            # Dump environment variables to file
            term.write(f" env | grep AWS > {filename}\n")
            
            # Wait for file to be written
            import time
            time.sleep(1.0)
            
            creds = {}
            if os.path.exists(filename):
                with open(filename, 'r') as f:
                    for line in f:
                        if '=' in line:
                            key, value = line.strip().split('=', 1)
                            if key in ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE']:
                                creds[key] = value
                
                # Clean up
                try:
                    os.remove(filename)
                except:
                    pass
                    
                if creds:
                    user_credentials[sid] = creds
                    return jsonify({'success': True, 'count': len(creds)})
            
            return jsonify({'success': False, 'error': 'No AWS credentials found in terminal'})
            
        return jsonify({'success': False, 'error': 'Terminal session not found'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/check-credentials', methods=['POST'])
def check_credentials():
    """Check if AWS credentials are valid and return account info"""
    try:
        data = request.get_json() or {}
        sid = data.get('socket_id')
        creds = user_credentials.get(sid, {})
        
        # Create session with synced credentials if available
        if creds:
            session = boto3.Session(
                aws_access_key_id=creds.get('AWS_ACCESS_KEY_ID'),
                aws_secret_access_key=creds.get('AWS_SECRET_ACCESS_KEY'),
                aws_session_token=creds.get('AWS_SESSION_TOKEN'),
                region_name=creds.get('AWS_REGION', creds.get('AWS_DEFAULT_REGION')),
                profile_name=creds.get('AWS_PROFILE')
            )
        else:
            session = boto3.Session()
            
        sts = session.client('sts')
        identity = sts.get_caller_identity()
        return jsonify({
            'success': True,
            'account': identity.get('Account'),
            'arn': identity.get('Arn'),
            'user_id': identity.get('UserId'),
            'synced': bool(creds)
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        })

@app.route('/api/fetch-results', methods=['POST'])
def fetch_results():
    """Fetch MLflow results from S3 for given JOB_ID"""
    try:
        data = request.get_json()
        job_id = data.get('job_id', '').strip()
        
        if not job_id:
            return jsonify({'success': False, 'error': 'JOB_ID is required'}), 400
        
        # Initialize S3 client with synced credentials
        sid = data.get('socket_id')
        creds = user_credentials.get(sid, {})
        
        if creds:
            session = boto3.Session(
                aws_access_key_id=creds.get('AWS_ACCESS_KEY_ID'),
                aws_secret_access_key=creds.get('AWS_SECRET_ACCESS_KEY'),
                aws_session_token=creds.get('AWS_SESSION_TOKEN'),
                region_name=creds.get('AWS_REGION', creds.get('AWS_DEFAULT_REGION')),
                profile_name=creds.get('AWS_PROFILE')
            )
        else:
            session = boto3.Session()
            
        s3 = session.client('s3')
        
        # List results files
        results_prefix = f'{job_id}/llmAsJudgeEval/results/'
        
        response = s3.list_objects_v2(
            Bucket=RESULTS_BUCKET,
            Prefix=results_prefix
        )
        
        files = response.get('Contents', [])
        
        if not files:
            return jsonify({
                'success': False,
                'error': f'No results found for JOB_ID: {job_id}',
                'searched_path': f's3://{RESULTS_BUCKET}/{results_prefix}'
            })
        
        # Read all results files
        results = []
        for f in files:
            filename = f['Key'].split('/')[-1]
            if not filename.endswith('.jsonl'):
                continue
                
            obj = s3.get_object(Bucket=RESULTS_BUCKET, Key=f['Key'])
            data = json.loads(obj['Body'].read())
            
            # Parse original field for test case context
            original_data = json.loads(data.get('original', '{}'))
            test_case_id = original_data.get('test_case_id', filename.replace('.jsonl', ''))
            
            # Build result row
            row = {
                'test_case_id': test_case_id,
                'filename': filename,
                'result': data.get('result', 'N/A'),
                'scores': {}
            }
            
            # Extract scores
            for score in data.get('scores', []):
                row['scores'][score['name']] = {
                    'value': score['value'],
                    'context': score.get('context', ''),
                    'error': score.get('error')
                }
            
            results.append(row)
        
        # Get unique score names for table headers
        all_score_names = set()
        for r in results:
            all_score_names.update(r['scores'].keys())
        
        return jsonify({
            'success': True,
            'job_id': job_id,
            'file_count': len(results),
            'score_names': sorted(list(all_score_names)),
            'results': results,
            's3_path': f's3://{RESULTS_BUCKET}/{results_prefix}'
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/get-result-detail', methods=['POST'])
def get_result_detail():
    """Get detailed result for a specific test case"""
    try:
        data = request.get_json()
        job_id = data.get('job_id')
        filename = data.get('filename')
        
        sid = data.get('socket_id')
        creds = user_credentials.get(sid, {})
        
        if creds:
            session = boto3.Session(
                aws_access_key_id=creds.get('AWS_ACCESS_KEY_ID'),
                aws_secret_access_key=creds.get('AWS_SECRET_ACCESS_KEY'),
                aws_session_token=creds.get('AWS_SESSION_TOKEN'),
                region_name=creds.get('AWS_REGION', creds.get('AWS_DEFAULT_REGION')),
                profile_name=creds.get('AWS_PROFILE')
            )
        else:
            session = boto3.Session()
            
        s3 = session.client('s3')
        key = f'{job_id}/llmAsJudgeEval/results/{filename}'
        
        obj = s3.get_object(Bucket=RESULTS_BUCKET, Key=key)
        result_data = json.loads(obj['Body'].read())
        
        return jsonify({
            'success': True,
            'data': result_data
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# Terminal Socket Events
@socketio.on('connect')
def handle_connect():
    terminals[request.sid] = Terminal(request.sid)

@socketio.on('terminal_input')
def handle_terminal_input(data):
    if request.sid in terminals:
        terminals[request.sid].write(data['data'])

@socketio.on('terminal_resize')
def handle_terminal_resize(data):
    if request.sid in terminals:
        terminals[request.sid].resize(data['rows'], data['cols'])

@socketio.on('disconnect')
def handle_disconnect():
    if request.sid in terminals:
        terminals[request.sid].close()
        del terminals[request.sid]

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    socketio.run(app, debug=True, host='0.0.0.0', port=port)
