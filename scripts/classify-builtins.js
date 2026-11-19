#!/usr/bin/env node
/*
 * Generates data/builtins.json from:
 *   1. data/source/12dpl_functions_documentation.json — the 12dPL library documentation (primary;
 *      descriptions are used by the rules), and
 *   2. data/source/functions.compiler.json — the full compiler prototype list from
 *      https://github.com/ben-nightworks/12dpl-lang-server (MIT, see LICENSE.12dpl-lang-server),
 *      used to fill in overloads the documentation doesn't cover (Sqrt, Time, Sin, ...).
 *
 * Every overload gets a category and an honest/dishonest verdict with a reason. The rules
 * are deliberately simple and ordered: the first matching rule wins. Users don't edit this
 * output — they override it per workspace (see README).
 *
 *   node scripts/classify-builtins.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'data/source/12dpl_functions_documentation.json');
const compilerSrc = path.join(root, 'data/source/functions.compiler.json');
const out = path.join(root, 'data/builtins.json');
const docs = JSON.parse(fs.readFileSync(src, 'utf8'));
const compiler = JSON.parse(fs.readFileSync(compilerSrc, 'utf8'));

// ---------------------------------------------------------------------------
// Rules. Each: [category, test(fn), reason]. Tests receive
// { name, types: string[] (param + return types), desc }.
// ---------------------------------------------------------------------------

const UI_TYPE = /^(View_Draw|Sheet_Panel|Overlay_Widget|User_Input_Replay|Panel|Widget|Button|Select_Button|Menu|Horizontal_Group|Vertical_Group|Widget_Pages|Tree_Page|Screen_Text|Select_Boxes|Log_Line)$|_Box$/;
const PROJECT_TYPE = /^(Apply_Function|Kerb_Return_Function|Model|View|Tin|Function|Macro_Function|Apply_Many_Function|Undo|Undo_List|Drainage_Network|Function_Property_Collection)$/;
const DATABASE_TYPE = /^(Connection|Database_Result|Transaction|Query_Condition|Manual_Condition)$|_Query$/;
const FILE_TYPE = /^(File|Map_File|Plot_Parameter_File)$/;
const SYSTEM_TYPE = /^(Process_Handle|Macro_Handle)$/;

const anyType = (re) => (f) => f.types.some((t) => re.test(t));
/** Every type is a value type, and at least one matches `re` (the category marker). */
const allOf = (re) => (f) => f.types.every((t) => VALUE_TYPE.test(t)) && f.types.some((t) => re.test(t));
const VALUE_TYPE =
  /^(void|Integer|Integer64|Real|Text|Time|Element|Dynamic_Element|Uid|Attributes|Attribute_Blob|Textstyle_Data|Equality_Info|Equality_Label|Chain_Parameters|Parameter_Collection|Guid|SDR_Attribute|Point|Line|Arc|Spiral|Segment|Curve|Parabola|Vector2|Vector3|Vector4|Matrix3|Matrix4|XML_Document|XML_Node|Dynamic_(Real|Integer|Integer64|Text))$|_(Map|Multimap|Set|Multiset)$/;
const name = (re) => (f) => re.test(f.name);
const desc = (re) => (f) => re.test(f.desc);

const D = 'dishonest';
const H = 'honest';

/**
 * Extra name rules for overloads that only exist in the compiler prototype list (no description
 * to go on). Checked before the general rules.
 */
const UNDOCUMENTED_RULES = [
  ['math', name(/^(Pi|Two_pi|Half_pi|Absolute|Acos|Asin|Atan2?|Cos|Cosh|Sin|Sinh|Tan|Tanh|Exp|Log|Log10|Ldexp|Pow|Sqrt|Mod|Floor|Ceil|X(eq|ge|gt|le|lt|ne)y|Degrees_to_.*|Radians_to_.*|Hp_degrees_to_.*|Dms_to_degrees|Angle_to_bearing|Bearing_to_angle|Text_upper|Container_.*)$/), H,
    'Pure computation on its parameters.'],
  ['time', name(/^(Time|Start_timer|Stop_timer|Convert_time_to_local|Convert_time_to_gmt)$/), D, 'Depends on the system clock / time zone.'],
  ['ui', name(/^(Draw.*|Redraw|Clear_drawing|Highlight_.*|Unhighlight_.*|Update_line|Reset_image|Reload_tooltip|Set_caret|Set_bk_.*|Set_fill_colour|Set_rop|Set_tab|Get_tab|Has_child_page|Get_page_id|Save_graph_to_.*|Get_display_resolution|Get_allow_warp_cursor|Set_allow_warp_cursor|Get_notify_resizing|Set_notify_resizing|Clear_notify_resizing|Float_console|Minimize_console|Is_console_minimized|Get_console_position|Set_console_position|Dump_view_image|Create_high_resolution_image_from_OpenGL_view|Plan_view_set_viewport|Perspective_view_get_target_point|Kill_cad_command|Playback_command|Start_playback|TDF_.*)$/), D,
    'Draws on, or reads from, the screen / 12d user interface.'],
  ['system', name(/^(Process_.*|Register_On_Idle|Deregister_On_Idle|Wait_On_Idle|GIS_.*|Synergy_.*|Get_ip|Set_ip|Get_ip_draw_mode|Set_ip_draw_mode|Is_windows|Language|Reinitialize|Set_exit_code|Get_12dmodel_version|Get_program_.*|Compare_files|Macro_.*|Get_parent_macro|Create_macro_as_child|Run_.*|Prompt_chain_parameters_file|Chain_prompt_command|Get_macro_total_.*_locks|Clear_macro_cancelling)$/), D,
    'Reads or changes the state of the computer, network or 12d application.'],
  ['project', name(/^(Delete_models|Delete_tins|Delete_all_templates|Synchronize_all_.*|Selected_name_exists|Delete_macro_bim_element|Add_macro_bim_elements|Get_drainage_4d.*|Insert_macro_attribute_at_position|Get_project_.*|Set_project_.*|Insert_project_attribute_at_position|Get_function_.*|Set_function_.*|Function_attribute_.*|Insert_function_attribute_at_position|Get_drainage_network.*|Get_selected_vertices|Read_templates|Get_carto_projection_datum_names|Get_geodetic_projection_datum_names|Get_geodetic_info)$/), D,
    'Reads or changes the current 12d project.'],
];

/** Dishonest rules come first so that, e.g., a geometry call taking a Tin is dishonest. */
const RULES = [
  // --- explicit side effects / ambient state, by name ---------------------
  ['console', name(/^(Print|Print_.*|Clear_console|Show_console|Is_console_.*|Console_to_clipboard|Set_message_.*|Set_error_message|Save_output_window_to_XML|Read_output_window_from_XML|Destroy_on_exit|Retain_on_exit|Exit|Program_exit)$/), D,
    'Writes to or reads from the macro console / output window, or ends the program.'],
  ['ui', name(/(^|_)prompt$/i), D, 'Prompts the user for input.'],
  ['time', name(/^(Get_time|Date|Time|Sleep)$/), D, 'Depends on the system clock.'],
  ['random', name(/random/i), D, 'Uses the random number generator state.'],
  ['random', name(/^GUID_Gen$/), D, 'Generates a new unique id (non-deterministic).'],
  ['system', name(/^(ADAC_.*|Getenv|System|Shell_execute|Execute|Get_user_name|Get_license_client|Get_module_license|License_module_valid|Is_practise_version|Get_4dmodel_version|Process_exists|Get_clipboard_text|Set_clipboard_text|Get_cursor_position|Set_cursor_position|Get_last_child_macro_exit_code|Clear_last_child_macro_exit_code|Get_number_of_command_arguments|Get_command_argument|ADAC_get_xsd_path|Synergy_.*|Get_program_.*|Get_active_theme_image_directory|Create_process|Play_sound|Get_monitor_info|Get_number_of_monitors|Get_stack_trace|Run_slf_file|Get_temporary_.*)$/), D,
    'Reads or changes the state of the computer, the 12d application or the program command line.'],
  ['file', name(/^(File_.*|Directory_.*|Find_files|List_files_in_folder|List_subfolders_in_folder|Delete_files|Get_file_.*|Set_file_.*|Touch_file_.*|Read_.*|Write_.*|View_write_.*|Find_system_file.*|Backup_version_file|Restore_version_file|Get_disk_file_name|Get_directory|Set_directory|Get_absolute_path|Translate_XML_file|Plot_parameter_file|Plot_ppf_file|Create_.*_parameter_file|Add_dependancy_file|Get_dependancy_file|View_.*_file_exists|Get_SDR_field_file_type|Dump_slx_image|XML_to_12da|Get_image_size|Get_carto_projection_datum_data|Get_geodetic_projection_datum_data)$/), D,
    'Reads or writes files / folders on disk.'],
  ['project', name(/^(Get_project_.*|Set_project_.*|Project_.*|Remove_project_setting|Get_active_project_settings_profile|Set_active_project_settings_profile|Read_project_settings_file|Get_4d_units|Set_4d_units|Colour_exists|Convert_colour|Set_colour_value|Linestyle_exists|Textstyle_exists|Template_exists|Symbol_exists|Inquire_style_exists|Get_current_inquire_style|Model_exists|Tin_exists|View_exists|Function_exists|Macro_attribute_.*|Find_models|Find_tins|Find_views|Find_element|Get_element|Is_global|Get_next_uid|Get_last_uid|Get_next_id|Get_last_id|Get_read_locks|Get_write_locks|Highlight_.*|Draw_elements|Element_draw.*|View_.*|Tile_all_views|Get_last_view|Get_drainage_.*_types?|Get_drainage_number_of_.*|Get_drainage_manhole_.*|Get_drainage_(grade|sag)_curve.*|Get_drainage_intensity|Get_drainage_pipe_(roughness|type)|Get_water_defaults_.*|Set_water_defaults_.*|Get_rainfall_.*|Run_.*|.*_rename|Function_delete|Delete_function_strings_and_models|Get_.*_controlbar|Set_.*_controlbar|Is_12d_.*|Synchronize_shared_.*|Unshare_out_.*|Regrade_pipes|Plot_mps|Get_active_theme_name|Clear_macro_allow_cancelling|Recalc_chain_running|Check_object_tree_enable|Set_pit_details|Is_dumping_widgets|DRF_(dimension|leader|table)_style_property|Create_macro|Get_billboard_size|Get_macro_.*|Set_macro_.*|Get_module_.*|Plotter_.*|Get_property_colour|Set_property_colour|Get_text_units|Set_text_units)$/), D,
    'Reads or changes the current 12d project (models, tins, views, settings, colours, styles...).'],

  // Colour-table lookups by name/number (the Element/Textstyle overloads just set a field).
  ['project', (f) => /^(Get_colour|Set_colour)$/.test(f.name) && f.types.every((t) => /^(void|Integer|Real|Text)$/.test(t)), D,
    'Looks up the project colour table.'],

  // --- dishonest by the kind of object the call touches -------------------
  ['ui', anyType(UI_TYPE), D, 'Creates or talks to panels / widgets on screen.'],
  ['project', anyType(PROJECT_TYPE), D, 'Reads or changes models, views, tins or other objects in the 12d project.'],
  ['database', anyType(DATABASE_TYPE), D, 'Talks to an external database.'],
  ['file', anyType(FILE_TYPE), D, 'Reads or writes a file.'],
  ['system', anyType(SYSTEM_TYPE), D, 'Controls an external process.'],

  // --- dishonest by documentation wording --------------------------------
  ['project', desc(/\b(current project|the project'?s?|in the project|project (attribute|setting)s?|12d ?model (database|session)|the 12d database)\b/i), D,
    'Documentation says it uses the current 12d project.'],
  ['console', desc(/\b(output window|macro console|message area|information\/error)\b/i), D, 'Documentation says it writes to the console / output window.'],
  ['ui', desc(/\b(on the screen|the user (selects|picks|enters|clicks)|ask(s)? the user|dialog)\b/i), D, 'Documentation says it interacts with the user.'],
  ['system', desc(/\b(clipboard|registry|environment variable|operating system|the computer|system clock|current (date|time)|current executable)\b/i), D,
    'Documentation says it depends on the computer / operating system.'],
  ['file', desc(/\b(on disk|from (the )?disk|to (the )?disk|the file system|file named|(from|to|into) (a|the) file)\b/i), D, 'Documentation says it reads or writes a file.'],

  // --- dishonest by name pattern (debug/dump write to the output window) -----
  ['console', name(/_(debug|dump)$/), D, 'Writes to the output window.'],

  // --- honest: only touches its parameters -------------------------------
  // Only when *every* type in the signature is a plain value / in-memory type.
  ['container', allOf(/_(Map|Multimap|Set|Multiset)$/), H, 'Operates on the container passed to it.'],
  ['element', allOf(/^(Element|Dynamic_Element|Uid|Attributes|Attribute_Blob|Textstyle_Data|Equality_Info|Equality_Label|Chain_Parameters|Parameter_Collection|Guid|SDR_Attribute)$/), H,
    'Operates only on the element / value handles passed to it.'],
  ['geometry', allOf(/^(Point|Line|Arc|Spiral|Segment|Curve|Parabola|Vector2|Vector3|Vector4|Matrix3|Matrix4)$/), H, 'Pure geometry on its parameters.'],
  ['xml', allOf(/^(XML_Document|XML_Node)$/), H, 'Operates on an in-memory XML document passed to it.'],
  ['container', allOf(/^Dynamic_(Real|Integer|Integer64|Text)$/), H, 'Operates on the dynamic array passed to it.'],
  ['text', allOf(/^Text$/), H, 'Pure text processing on its parameters.'],
  ['math', allOf(/^(Integer|Integer64|Real|Time)$/), H, 'Pure computation on its parameters.'],
  ['other', (f) => f.types.every((t) => VALUE_TYPE.test(t)), H, 'Only accesses its parameters.'],
  ['other', () => true, D, 'Uses an object type the classifier does not know; assumed dishonest.'],
];

function classify(fn, undocumented) {
  const types = [fn.returnType, ...fn.parameters.map((p) => p.type)].filter(Boolean);
  const f = { name: fn.name, types, desc: undocumented ? '' : fn.description || '' };
  for (const [category, test, honesty, reason] of undocumented ? [...UNDOCUMENTED_RULES, ...RULES] : RULES) {
    if (test(f)) return { category, honesty, reason: undocumented ? `${reason} (Not in the documentation; classified from its name and parameter types.)` : reason };
  }
  throw new Error('unreachable');
}

// Merge: every documented overload, plus compiler overloads whose (name, param types) aren't documented.
const typeKey = (fn) => `${fn.name}(${fn.parameters.map((p) => p.type).join(',')})`;
const documented = new Set(docs.map(typeKey));
const all = [
  ...docs.map((fn) => ({ fn, undocumented: false })),
  ...compiler
    .filter((fn) => !documented.has(typeKey(fn)) && !/^__/.test(fn.name))
    .map((fn) => ({ fn, undocumented: true })),
];
// Drop exact duplicates within the compiler list itself.
const seenKeys = new Set();

const functions = {};
for (const { fn, undocumented } of all) {
  if (undocumented) {
    if (seenKeys.has(typeKey(fn))) continue;
    seenKeys.add(typeKey(fn));
  }
  const c = classify(fn, undocumented);
  const params = fn.parameters.map((p) => {
    const ref = p.name.startsWith('&');
    return { name: p.name.replace(/^&/, ''), type: p.type, ref };
  });
  const signature = `${fn.name}(${params.map((p) => p.type + (p.ref ? ' &' : '')).join(', ')})`;
  const entry = {
    id: fn.id,
    signature,
    returnType: fn.returnType,
    params,
    category: c.category,
    honesty: c.honesty,
    reason: c.reason,
    ...(undocumented ? { undocumented: true } : {}),
  };
  (functions[fn.name] ||= []).push(entry);
}

const sorted = Object.fromEntries(Object.keys(functions).sort().map((k) => [k, functions[k]]));
const counts = {};
for (const list of Object.values(sorted)) for (const e of list) counts[`${e.honesty}/${e.category}`] = (counts[`${e.honesty}/${e.category}`] || 0) + 1;

// One overload per line: compact, but still diff-friendly when the rules change.
const lines = Object.entries(sorted).map(
  ([n, list]) => `  ${JSON.stringify(n)}: [\n${list.map((e) => '   ' + JSON.stringify(e)).join(',\n')}\n  ]`,
);
fs.writeFileSync(
  out,
  `{\n "generatedFrom": ${JSON.stringify([path.basename(src), path.basename(compilerSrc)])},\n "functions": {\n${lines.join(',\n')}\n }\n}\n`,
);
const total = Object.values(sorted).reduce((n, l) => n + l.length, 0);
console.log(`Wrote ${out}: ${Object.keys(sorted).length} names, ${total} overloads (${total - docs.length} undocumented)`);
console.log(Object.entries(counts).sort().map(([k, v]) => `  ${k}: ${v}`).join('\n'));
