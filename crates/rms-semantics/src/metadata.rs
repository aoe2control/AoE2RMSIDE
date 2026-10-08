#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandKind {
    Command,
    Attribute,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommandMetadata {
    pub name: &'static str,
    pub section: &'static str,
    pub kind: CommandKind,
    pub minimum_arguments: u8,
    pub maximum_arguments: u8,
    pub signature: &'static str,
    pub documentation: &'static str,
}

const COMMANDS: &[CommandMetadata] = &[
    CommandMetadata {
        name: "random_placement",
        section: "player_setup",
        kind: CommandKind::Command,
        minimum_arguments: 0,
        maximum_arguments: 0,
        signature: "random_placement",
        documentation: "Selects random player placement for the player setup section.",
    },
    CommandMetadata {
        name: "create_land",
        section: "land_generation",
        kind: CommandKind::Command,
        minimum_arguments: 0,
        maximum_arguments: 0,
        signature: "create_land { … }",
        documentation: "Creates a land descriptor. Land attributes belong inside its braces.",
    },
    CommandMetadata {
        name: "terrain_type",
        section: "land_generation",
        kind: CommandKind::Attribute,
        minimum_arguments: 1,
        maximum_arguments: 1,
        signature: "terrain_type <terrain-id>",
        documentation: "Sets the terrain identifier for the current land descriptor.",
    },
    CommandMetadata {
        name: "base_size",
        section: "land_generation",
        kind: CommandKind::Attribute,
        minimum_arguments: 1,
        maximum_arguments: 1,
        signature: "base_size <tiles>",
        documentation: "Sets the base size of the current land descriptor.",
    },
    CommandMetadata {
        name: "land_percent",
        section: "land_generation",
        kind: CommandKind::Attribute,
        minimum_arguments: 1,
        maximum_arguments: 1,
        signature: "land_percent <percent>",
        documentation: "Sets the target land percentage for the current descriptor.",
    },
    CommandMetadata {
        name: "create_elevation",
        section: "elevation_generation",
        kind: CommandKind::Command,
        minimum_arguments: 1,
        maximum_arguments: 1,
        signature: "create_elevation <height> { … }",
        documentation: "Creates an elevation descriptor for the requested height.",
    },
    CommandMetadata {
        name: "create_terrain",
        section: "terrain_generation",
        kind: CommandKind::Command,
        minimum_arguments: 1,
        maximum_arguments: 1,
        signature: "create_terrain <terrain-id> { … }",
        documentation: "Creates a terrain-generation descriptor.",
    },
    CommandMetadata {
        name: "create_connect_all_lands",
        section: "connection_generation",
        kind: CommandKind::Command,
        minimum_arguments: 0,
        maximum_arguments: 0,
        signature: "create_connect_all_lands { … }",
        documentation: "Creates a connection descriptor joining generated lands.",
    },
    CommandMetadata {
        name: "create_object",
        section: "objects_generation",
        kind: CommandKind::Command,
        minimum_arguments: 1,
        maximum_arguments: 1,
        signature: "create_object <object-id> { … }",
        documentation: "Creates an object-placement descriptor.",
    },
    CommandMetadata {
        name: "number_of_objects",
        section: "objects_generation",
        kind: CommandKind::Attribute,
        minimum_arguments: 1,
        maximum_arguments: 1,
        signature: "number_of_objects <count>",
        documentation: "Sets the count for the current object descriptor.",
    },
];

pub fn command_metadata() -> &'static [CommandMetadata] {
    COMMANDS
}

pub fn find_command(section: &str, name: &str) -> Option<&'static CommandMetadata> {
    COMMANDS.iter().find(|command| {
        command.section.eq_ignore_ascii_case(section) && command.name.eq_ignore_ascii_case(name)
    })
}
