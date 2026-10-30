"""Free usage diagnostic: an offline tool that reads the local Claude Code transcripts, shows facts,
writes a one-page HTML report and, only with consent, builds a structured payload. It makes no network call."""
from .seam import IMPL
from .facts import TYPE_WORDS, scan, type_word, norm_model
from .report import render_html
from .payload import CLIENT_VERSION, SendDisabled, build_payload, load_salt, ref, send
from .cli import main

__all__ = ['IMPL', 'TYPE_WORDS', 'scan', 'type_word', 'norm_model', 'render_html', 'CLIENT_VERSION', 'SendDisabled',
           'build_payload', 'load_salt', 'ref', 'send', 'main']
