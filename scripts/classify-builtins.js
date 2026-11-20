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
// The principle
//
// A function is honest when everything it reads or changes comes in through its parameters.
// *Handles count as parameters*: View_add_model(view, model) only touches the view and model it
// was given, so it is honest. A call is dishonest when it reaches something that was NOT passed
// in:
//   - looks a handle up by name/id from the project   Get_view("1"), Get_model("x"), Create_model("x")
//   - the screen / event loop / cursor                Show_widget, Wait_on_events, Model_draw
//   - the console, clock, random state, command line, environment, project settings, disk by name
//
// Rules: [category, test(f), honesty, reason]; the first match wins. Tests receive
//   f = { name, desc, types: string[] (return + params), params: {type, ref}[], ret }
// ---------------------------------------------------------------------------

const UI_TYPE = /^(View_Draw|Sheet_Panel|Overlay_Widget|User_Input_Replay|Panel|Widget|Button|Select_Button|Menu|Horizontal_Group|Vertical_Group|Widget_Pages|Tree_Page|Screen_Text|Select_Boxes|Log_Line)$|_Box$/;
const PROJECT_TYPE = /^(Apply_Function|Kerb_Return_Function|Model|View|Tin|Function|Macro_Function|Apply_Many_Function|Undo|Undo_List|Drainage_Network|Function_Property_Collection)$/;
const DATABASE_TYPE = /^(Connection|Database_Result|Transaction|Query_Condition|Manual_Condition)$|_Query$/;
const FILE_TYPE = /^(File|Map_File|Plot_Parameter_File)$/;
const SYSTEM_TYPE = /^(Process_Handle|Macro_Handle)$/;
/** Handles that 12d registers in the project by name: getting one without being given a handle is a lookup. */
const NAMED_PROJECT_TYPE = /^(Model|View|Tin|Function|Macro_Function|Apply_Function|Apply_Many_Function|Kerb_Return_Function|Drainage_Network)$/;
const ELEMENT_HANDLE = /^(Element|Dynamic_Element)$/;

const VALUE_TYPE =
  /^(void|Integer|Integer64|Real|Text|Time|Element|Dynamic_Element|Uid|Attributes|Attribute_Blob|Textstyle_Data|Equality_Info|Equality_Label|Chain_Parameters|Parameter_Collection|Guid|SDR_Attribute|Point|Line|Arc|Spiral|Segment|Curve|Parabola|Vector2|Vector3|Vector4|Matrix3|Matrix4|XML_Document|XML_Node|Dynamic_(Real|Integer|Integer64|Text))$|_(Map|Multimap|Set|Multiset)$/;
const isHandle = (t) => UI_TYPE.test(t) || PROJECT_TYPE.test(t) || DATABASE_TYPE.test(t) || FILE_TYPE.test(t) || SYSTEM_TYPE.test(t) || ELEMENT_HANDLE.test(t);

/** Input parameters (not `&` outputs). Undocumented prototypes carry no `&` info, so all count as inputs. */
const inputs = (f) => f.params.filter((p) => !p.ref);
const hasInput = (re) => (f) => inputs(f).some((p) => re.test(p.type));
const noHandleInput = (f) => !inputs(f).some((p) => isHandle(p.type));
const allOf = (re) => (f) => f.types.every((t) => VALUE_TYPE.test(t)) && f.types.some((t) => re.test(t));
const name = (re) => (f) => re.test(f.name);
const desc = (re) => (f) => re.test(f.desc);
const and = (...tests) => (f) => tests.every((t) => t(f));

/** Produces a project handle (return value or `&` output) without being handed any handle to derive it from. */
const lookup = (f) =>
  !/^Validate$/.test(f.name) &&
  noHandleInput(f) &&
  (NAMED_PROJECT_TYPE.test(f.ret) || f.params.some((p) => p.ref && NAMED_PROJECT_TYPE.test(p.type)));

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
  ['screen', name(/^(Highlight_.*|Unhighlight_.*|Get_display_resolution|Get_allow_warp_cursor|Set_allow_warp_cursor|Float_console|Minimize_console|Is_console_minimized|Get_console_position|Set_console_position|Kill_cad_command|Playback_command|Start_playback|TDF_.*)$/), D,
    'Uses the screen / 12d user interface, which is not passed in.'],
  ['screen', and(noHandleInput, name(/^(Redraw|Clear_drawing|Draw_element|Dump_view_image|Create_high_resolution_image_from_OpenGL_view)$/)), D,
    'Draws on the screen without being given what to draw on.'],
  ['system', name(/^(Process_.*|Register_On_Idle|Deregister_On_Idle|Wait_On_Idle|GIS_.*|Synergy_.*|Get_ip|Set_ip|Get_ip_draw_mode|Set_ip_draw_mode|Is_windows|Language|Reinitialize|Set_exit_code|Get_12dmodel_version|Get_program_.*|Compare_files|Macro_.*|Get_parent_macro|Create_macro_as_child|Run_.*|Prompt_chain_parameters_file|Chain_prompt_command|Get_macro_total_.*_locks|Clear_macro_cancelling)$/), D,
    'Reads or changes the state of the computer, network or 12d application.'],
  ['project', and(noHandleInput, name(/^(Delete_models|Delete_tins|Delete_all_templates|Synchronize_all_.*|Selected_name_exists|Delete_macro_bim_element|Add_macro_bim_elements|Get_drainage_4d.*|Insert_macro_attribute_at_position|Get_project_.*|Set_project_.*|Insert_project_attribute_at_position|Get_drainage_network.*|Get_selected_vertices|Read_templates|Get_carto_projection_datum_names|Get_geodetic_projection_datum_names|Get_geodetic_info)$/)), D,
    'Reads or changes the current 12d project without being given a handle to it.'],
];

const RULES = [
  // --- ambient state reached by name, whatever the parameters --------------
  ['console', name(/^(Print|Print_.*|Clear_console|Show_console|Is_console_.*|Console_to_clipboard|Set_message_.*|Set_error_message|Get_last_error|Save_output_window_to_XML|Read_output_window_from_XML|Destroy_on_exit|Retain_on_exit|Exit|Program_exit)$/), D,
    'Writes to or reads from the macro console / output window, or ends the program.'],
  ['console', name(/_(debug|dump)$/), D, 'Writes to the output window.'],
  ['prompt', name(/(^|_)prompt$/i), D, 'Prompts the user for input.'],
  ['time', name(/^(Get_time|Date|Time|Sleep)$/), D, 'Depends on the system clock.'],
  ['random', name(/random/i), D, 'Uses the random number generator state.'],
  ['random', name(/^GUID_Gen$/), D, 'Generates a new unique id (non-deterministic).'],
  ['system', name(/^(ADAC_.*|Getenv|System|Shell_execute|Execute|Get_user_name|Get_license_client|Get_module_license|License_module_valid|Is_practise_version|Get_4dmodel_version|Process_exists|Get_clipboard_text|Set_clipboard_text|Get_cursor_position|Set_cursor_position|Get_last_child_macro_exit_code|Clear_last_child_macro_exit_code|Get_number_of_command_arguments|Get_command_argument|Synergy_.*|Get_program_.*|Get_active_theme_image_directory|Get_active_theme_name|Create_process|Play_sound|Get_monitor_info|Get_number_of_monitors|Get_stack_trace|Run_slf_file|Get_temporary_.*|Is_12d_.*|Create_macro|Clear_macro_allow_cancelling|Recalc_chain_running|Is_dumping_widgets)$/), D,
    'Reads or changes the state of the computer, the 12d application or the program command line.'],
  ['system', name(/^Process_/), D, 'Controls an external process.'],
  ['screen', name(/^(Wait_on_events|Wait_on_widgets|Show_widget|Hide_widget|Show_browse_button|Model_draw.*|Display|Display_relative|Winhelp|Element_draw.*|Draw_elements|Highlight_.*|Start_batch_draw|End_batch_draw|Tile_all_views|Get_last_view|Get_current_inquire_style)$/), D,
    'Uses the screen, cursor or event loop, which are not passed in as parameters.'],

  // --- the disk, reached by file / folder name (not via a File handle passed in) ---
  ['file', and(noHandleInput, name(/^(File_.*|Map_file_.*|Directory_.*|Find_files|List_files_in_folder|List_subfolders_in_folder|Delete_files|Get_file_.*|Set_file_.*|Touch_file_.*|Read_.*|Write_.*|Find_system_file.*|Backup_version_file|Restore_version_file|Get_disk_file_name|Get_directory|Set_directory|Get_absolute_path|Translate_XML_file|Plot_parameter_file|Plot_ppf_file|Create_.*_parameter_file|Get_SDR_field_file_type|Dump_slx_image|XML_to_12da|Get_image_size|Get_carto_projection_datum_data|Get_geodetic_projection_datum_data|Get_billboard_size)$/)), D,
    'Reads or writes files / folders on disk by name.'],
  ['file', (f) => !hasInput(FILE_TYPE)(f) && /^(Save_.*_to_(bmp|emf|jpg|png|svg)|Dump_view_image|Create_high_resolution_image_from_OpenGL_view|Read_STL_file|Read_favorite|Write_favorite|Write_XML|Read_playback|View_write_.*|View_.*_file_exists|Write_XML_[Dd]ocument|Write_12d.*|Write_4d_ascii|Write_DAE_file|Write_SLX|Write_to_file|Read_XML_document|Read_12d_data|Read_4d_ascii|Read_PDF|Read_SLX|Read_parameter_file|Write_parameter_file|Add_dependancy_file|Get_dependancy_file)$/.test(f.name), D,
    'Reads or writes a file on disk by name.'],

  // --- the project, reached by name / global settings ---------------------
  ['project', and(noHandleInput, name(/^(Get_project_.*|Set_project_.*|Project_.*|Remove_project_setting|Get_active_project_settings_profile|Set_active_project_settings_profile|Read_project_settings_file|Get_4d_units|Set_4d_units|Colour_exists|Convert_colour|Set_colour_value|Linestyle_exists|Textstyle_exists|Template_exists|Symbol_exists|Inquire_style_exists|Model_exists|Tin_exists|View_exists|Function_exists|Macro_attribute_.*|Get_macro_.*|Set_macro_.*|Find_models|Find_tins|Find_views|Find_element|Get_element|Is_global|Get_next_uid|Get_last_uid|Get_next_id|Get_last_id|Get_read_locks|Get_write_locks|Get_drainage_.*|Set_drainage_.*|Get_water_defaults_.*|Set_water_defaults_.*|Get_rainfall_.*|Run_.*|.*_rename|Function_delete|Delete_function_strings_and_models|Get_.*_controlbar|Set_.*_controlbar|Synchronize_shared_.*|Unshare_out_.*|Regrade_pipes|Plot_mps|Set_pit_details|Check_object_tree_enable|DRF_(dimension|leader|table)_style_property|Get_module_.*|Plotter_.*|Get_property_colour|Set_property_colour|Get_text_units|Set_text_units)$/)), D,
    'Reads or changes the current 12d project (settings, colours, styles, names...) without being given a handle to it.'],
  ['project', (f) => /^(Get_colour|Set_colour)$/.test(f.name) && f.types.every((t) => /^(void|Integer|Real|Text)$/.test(t)), D,
    'Looks up the project colour table.'],
  ['project', lookup, D,
    'Gets (or creates) a model / view / tin / function in the project by name or id — the handle was neither passed in nor built from its parameters.'],

  // --- dishonest by documentation wording (only when no handle is passed in) ---
  ['file', and(noHandleInput, desc(/\b(on disk|from (the )?disk|to (the )?disk|the file system|file named|(from|to|into) (a|the) file)\b/i)), D, 'Documentation says it reads or writes a file by name.'],
  // Building a new panel / widget only uses its parameters, even though widgets end up on screen.
  ['ui-handle', (f) => /^Create_/.test(f.name) && UI_TYPE.test(f.ret), H, 'Builds a new panel / widget from its parameters.'],
  ['console', and(noHandleInput, desc(/\b(output window|macro console|message area|information\/error)\b/i)), D, 'Documentation says it writes to the console / output window.'],
  ['system', desc(/\b(clipboard|registry|environment variable|operating system|the computer|system clock|current (date|time)|current executable)\b/i), D,
    'Documentation says it depends on the computer / operating system.'],
  ['project', and(noHandleInput, desc(/\b(current project|the project'?s?|in the project|project (attribute|setting)s?|12d ?model (database|session)|the 12d database)\b/i)), D,
    'Documentation says it uses the current 12d project, and no handle is passed in.'],
  ['screen', and(noHandleInput, desc(/\b(on the screen|the user (selects|picks|enters|clicks)|ask(s)? the user|dialog)\b/i)), D, 'Documentation says it interacts with the user / screen.'],

  // --- honest: everything it touches is a parameter (handles included) ------
  ['ui-handle', hasInput(UI_TYPE), H, 'Only touches the panel / widget handles passed to it.'],
  ['ui-handle', (f) => f.types.some((t) => UI_TYPE.test(t)), H, 'Builds a new panel / widget from its parameters.'],
  ['project-handle', (f) => f.types.some((t) => PROJECT_TYPE.test(t)), H, 'Only touches the model / view / tin handles passed to it.'],
  ['file-handle', (f) => f.types.some((t) => FILE_TYPE.test(t)), H, 'Only touches the file handle passed to it.'],
  ['database-handle', (f) => f.types.some((t) => DATABASE_TYPE.test(t)), H, 'Only touches the database handles passed to it.'],
  ['system-handle', hasInput(SYSTEM_TYPE), H, 'Only touches the macro handle passed to it.'],
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
  const params = fn.parameters.map((p) => ({ type: p.type, ref: p.name.startsWith('&') }));
  const f = { name: fn.name, types, params, ret: fn.returnType, desc: undocumented ? '' : fn.description || '' };
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
