// Release builds are a GUI program: no console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fleet_desktop_lib::run();
}
