"""Last-live baseline and artifact packaging for the gated Pages workflow."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

BOOTSTRAP = '091ceaec41e127f46bdc4364edd93ac291ec2f7e'
SITE = 'https://ww634.github.io/bilingual-reader/'
ROOT = Path(__file__).resolve().parents[2]

def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()

def baseline():
    nonce = os.environ.get('RELEASE_NONCE', 'local')
    req = urllib.request.Request(SITE + 'content/qa-release.json?run=' + nonce,
                                 headers={'Cache-Control': 'no-cache'})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            marker = json.load(response)
        assert marker['schema'] == 1, 'Unknown live release marker'
        ref = marker['commit']
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        # Only the original, explicitly grandfathered release can bootstrap.
        # A transient outage or malformed marker never silently bypasses QA.
        ref = BOOTSTRAP
    assert len(ref) == 40 and all(c in '0123456789abcdef' for c in ref), 'Invalid live SHA'
    subprocess.run(['git', 'merge-base', '--is-ancestor', ref, 'HEAD'], cwd=ROOT, check=True)
    return ref

def check():
    ref = baseline()
    subprocess.run(['node', 'tools/qa/publication.mjs', 'check', '--base', ref, '--head', 'HEAD'], cwd=ROOT, check=True)
    (ROOT / '.qa-checked.json').write_text(json.dumps({'base': ref, 'commit': run('git', 'rev-parse', 'HEAD')}))

def build():
    checked = json.loads((ROOT / '.qa-checked.json').read_text())
    commit = run('git', 'rev-parse', 'HEAD')
    assert checked['commit'] == commit, 'HEAD changed after QA'
    out = ROOT / '_site'
    assert not out.exists(), 'Artifact directory already exists'
    out.mkdir()
    def ignore(directory, names):
        return [n for n in names if n.startswith(('.', '_')) or n == 'node_modules']
    for name in ['app', 'content']:
        shutil.copytree(ROOT / name, out / name, ignore=ignore)
    (out / 'content/qa-release.json').write_text(json.dumps({'schema': 1, 'commit': commit, 'reviewed_from': checked['base']}) + '\n')
    (out / '.nojekyll').touch()
    print('Built reviewed app/content artifact at', commit)

if __name__ == '__main__':
    {'check': check, 'build': build}[sys.argv[1]]()
