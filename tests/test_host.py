"""Self-contained checks: python -m unittest discover -s tests -v"""
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE_FILE = Path(__file__).resolve().parents[1] / 'native' / 'host.py'
spec = importlib.util.spec_from_file_location('brook_host', MODULE_FILE)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class HostTests(unittest.TestCase):
    def test_filename_sanitized(self):
        self.assertEqual(host.safe_filename('  Video: / <test>?  .mp4  '), 'Video test')
        self.assertEqual(host.safe_filename('../outside'), 'outside')  # No folder traversal
        self.assertEqual(host.safe_filename('CON'), '_CON')
        self.assertEqual(host.safe_filename(''), 'Video')
        self.assertEqual(host.safe_filename('Titolo % ok'), 'Titolo % ok')

    def test_url_restrictions(self):
        self.assertTrue(host.valid_url('https://example.com/path/stream.m3u8'))
        self.assertFalse(host.valid_url('file:///etc/passwd'))
        self.assertFalse(host.valid_url('http://localhost:4000/foo'))
        self.assertFalse(host.valid_url('http://192.168.1.2/test'))

    def test_unique_stem(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            (p / 'Film.mp4').write_bytes(b'x')
            self.assertEqual(host.unique_stem(p, 'Film'), 'Film (2)')
            (p / 'Film (2).webm').write_bytes(b'x')
            self.assertEqual(host.unique_stem(p, 'Film'), 'Film (3)')

    def test_cancel_chooser_does_not_download(self):
        responses = []
        with patch.object(host, 'send', side_effect=responses.append), \
             patch.object(host, 'ffmpeg_tools', return_value=('ffmpeg', 'ffprobe')), \
             patch.object(host, 'choose_folder', return_value=None), \
             patch.object(host.subprocess, 'Popen') as popen:
            host.handle_download({'url': 'https://example.com/stream.m3u8', 'askWhere': True, 'fileName': 'Test'})
        self.assertTrue(responses[-1]['cancelled'])
        popen.assert_not_called()

    def test_gui_download_uses_selected_directory_and_name(self):
        with tempfile.TemporaryDirectory() as d:
            responses = []
            class FakeProcess:
                stdout = io.StringIO('[download] 10.0% of x\n[download] 100.0% of x\n')
                def wait(self):
                    return 0
            recorded = []
            def fake_popen(args, **kwargs):
                recorded.append(args)
                work_dir = Path(args[args.index('--paths') + 1])
                (work_dir / 'Mio video % prova.mp4').write_bytes(b'fake-video')
                return FakeProcess()
            with patch.object(host, 'send', side_effect=responses.append), \
                 patch.object(host, 'choose_folder', return_value=Path(d)), \
                 patch.object(host, 'ffmpeg_tools', return_value=('ffmpeg','ffprobe')), \
                 patch.object(host, 'analyze_file', return_value=(True, True)), \
                 patch.object(host, 'convert_windows_mp4', side_effect=lambda src, *_: (src, '')), \
                 patch.object(host.subprocess, 'Popen', side_effect=fake_popen):
                host.handle_download({'url':'https://example.com/index.m3u8', 'referer':'https://example.com/player',
                                      'fileName':'Mio: video % prova.mp4', 'askWhere':True})
            args = recorded[0]
            self.assertEqual(Path(args[args.index('--paths')+1]).parent, Path(d))
            self.assertEqual(args[args.index('--output')+1], 'Mio video %% prova.%(ext)s')
            self.assertTrue((Path(d)/'Mio video % prova.mp4').exists())
            self.assertEqual(responses[-1]['ok'], True)
            self.assertTrue(any(x.get('percent') == 100 for x in responses))

    def test_without_chooser_uses_default_folder(self):
        with tempfile.TemporaryDirectory() as d:
            replies = []
            class FakeProcess:
                stdout = io.StringIO('')
                def wait(self):
                    return 0
            def fake_popen(args, **kwargs):
                work_dir = Path(args[args.index('--paths') + 1])
                (work_dir / 'Test.mp4').write_bytes(b'fake-video')
                return FakeProcess()
            with patch.object(host, 'OUT_DIR', Path(d)), \
                 patch.object(host, 'send', side_effect=replies.append), \
                 patch.object(host, 'choose_folder') as chooser, \
                 patch.object(host, 'ffmpeg_tools', return_value=('ffmpeg','ffprobe')), \
                 patch.object(host, 'analyze_file', return_value=(True, True)), \
                 patch.object(host, 'convert_windows_mp4', side_effect=lambda src, *_: (src, '')), \
                 patch.object(host.subprocess, 'Popen', side_effect=fake_popen):
                host.handle_download({'url':'https://example.com/video.mp4','fileName':'Test','askWhere':False})
            chooser.assert_not_called()
            self.assertTrue(replies[-1]['ok'])
            self.assertTrue((Path(d)/'Test.mp4').exists())


if __name__ == '__main__':
    unittest.main()
