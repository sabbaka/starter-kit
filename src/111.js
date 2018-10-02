import React from "react";

class HardwareInfo extends React.Component {
    constructor(props) {
        super(props);
        this.sortColumnFields = [ "cls", "model", "vendor", "slot" ];
        this.state = { sortBy: "cls" };
    }

    render() {
        let pci = null;

        if (this.props.info.pci.length > 0) {
            let sortedPci = this.props.info.pci.concat();
            sortedPci.sort((a, b) => a[this.state.sortBy].localeCompare(b[this.state.sortBy]));

            pci = (
                <Listing title={ _("PCI") } columnTitles={ [ _("Class"), _("Model"), _("Vendor"), _("Slot") ] }
            columnTitleClick={ index => this.setState({ sortBy: this.sortColumnFields[index] }) } >
            { sortedPci.map(dev => <ListingRow columns={[ dev.cls, dev.model, dev.vendor, dev.slot ]} />) }
            </Listing>
            );
            }

            return (
                <div className="page-ct container-fluid">
                <ol className="breadcrumb">
                <li><a role="link" tabIndex="0" onClick={ () => cockpit.jump("/system", cockpit.transport.host) }>{ _("System") }</a></li>
            <li className="active">{ _("Hardware Information") }</li>
            </ol>

            <h2>{ _("System Information") }</h2>
            <SystemInfo info={this.props.info.system} />

            { pci }
        </div>
        );
        }
    }
