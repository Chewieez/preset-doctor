// './install' must come first: it sets window.presetDoctor, which the UI reads when it loads.
import { folderAccessSupported } from './install';
import { mount } from '@preset-doctor/ui';

mount(document.getElementById('root')!, folderAccessSupported ? 'app' : 'unsupported');
