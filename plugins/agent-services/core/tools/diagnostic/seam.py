"""The one import seam: the usage module's parser and price table.

Loads the full usage parser by file path when one is installed alongside and tools/usage_core.py (parsing and
pricing) otherwise.
"""
import importlib.util
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
FULL_PATH = os.path.abspath(os.path.join(_HERE, '..', '..', 'modules', 'usage', 'impl.py'))
CORE_PATH = os.path.abspath(os.path.join(_HERE, '..', 'usage_core.py'))
IMPL_PATH = FULL_PATH if os.path.isfile(FULL_PATH) else CORE_PATH


def _load(path):
    spec = importlib.util.spec_from_file_location('agent_diagnostic_usage_impl', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


IMPL = _load(IMPL_PATH)
